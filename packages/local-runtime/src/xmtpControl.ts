import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, type ClientOptions, type DecodedMessage, type Signer, type XmtpEnv } from '@xmtp/node-sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, MAX_CONTROL_MESSAGE_BYTES, type MosaicNetwork } from './contracts.js';

export interface ControlTransportMessage {
  id: string;
  senderInboxId: string;
  sentAt: string;
  content: string;
}

export interface ControlTransport {
  readonly address: string;
  readonly inboxId: string;
  send(recipientInboxId: string, content: string): Promise<string>;
  start(onMessage: (message: ControlTransportMessage) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

interface StoredTransportIdentity {
  v: 1;
  privateKeyB64: string;
  databaseKeyB64: string;
}

export async function createXmtpControlTransport(params: {
  role: 'guardian' | 'runner';
  network: MosaicNetwork;
  directory: string;
}): Promise<ControlTransport> {
  const identity = await loadOrCreateIdentity(params.directory, `${params.role}-${params.network}`);
  const privateKey = new Uint8Array(Buffer.from(identity.privateKeyB64, 'base64'));
  const databaseKey = new Uint8Array(Buffer.from(identity.databaseKeyB64, 'base64'));
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const address = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`;
  const env: XmtpEnv = params.network === 'testnet' ? 'dev' : 'production';
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () => ({ identifier: address, identifierKind: 0 }),
    signMessage: async (message) => signXmtpMessage(privateKey, message),
  };
  const dbRoot = join(params.directory, 'xmtp');
  await mkdir(dbRoot, { recursive: true, mode: 0o700 });
  const client = await Client.create(signer, {
    env,
    appVersion: `mosaic-${params.role}-control/3.0.0`,
    dbPath: (inboxId) => join(dbRoot, `${env}-${inboxId}.db3`),
    dbEncryptionKey: databaseKey,
  } as ClientOptions);
  databaseKey.fill(0);
  let closed = false;
  let stream: Awaited<ReturnType<typeof client.conversations.streamAllDmMessages>> | undefined;
  let streamTask: Promise<void> | undefined;
  const deliver = async (message: DecodedMessage): Promise<void> => {
    if (closed || message.senderInboxId === client.inboxId || typeof message.content !== 'string') return;
    if (Buffer.byteLength(message.content, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) return;
    try {
      await handler?.({ id: message.id, senderInboxId: message.senderInboxId, sentAt: message.sentAt.toISOString(), content: message.content });
    } catch {
      // One malformed or unauthorized application message must not tear down
      // the long-lived XMTP stream. The application layer fails it closed.
    }
  };
  let handler: ((message: ControlTransportMessage) => Promise<void>) | undefined;
  return {
    address,
    inboxId: client.inboxId,
    async send(recipientInboxId, content) {
      if (closed) throw new Error('control transport is closed');
      if (!recipientInboxId || Buffer.byteLength(content, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) throw new Error('invalid control message');
      const dm = await client.conversations.createDm(recipientInboxId);
      return dm.sendText(content);
    },
    async start(onMessage) {
      if (streamTask) return;
      handler = onMessage;
      // Exactly one catch-up sync at startup. The live stream carries all
      // subsequent control traffic; there is no timer, heartbeat, or poll.
      await client.conversations.syncAll();
      for (const conversation of await client.conversations.list()) {
        for (const message of await conversation.messages()) await deliver(message);
      }
      stream = await client.conversations.streamAllDmMessages();
      streamTask = (async () => {
        for await (const message of stream!) await deliver(message as DecodedMessage);
      })();
      void streamTask.catch(() => {});
    },
    async close() {
      closed = true;
      await stream?.return?.();
      await streamTask?.catch(() => {});
      privateKey.fill(0);
    },
  };
}

export class InMemoryControlNetwork {
  private readonly receivers = new Map<string, (message: ControlTransportMessage) => Promise<void>>();
  private readonly backlog = new Map<string, ControlTransportMessage[]>();
  private nextId = 0;

  create(address: string, inboxId: string): ControlTransport {
    let closed = false;
    return {
      address,
      inboxId,
      send: async (recipientInboxId, content) => {
        if (closed) throw new Error('control transport is closed');
        const message: ControlTransportMessage = {
          id: `memory-${++this.nextId}`,
          senderInboxId: inboxId,
          sentAt: new Date().toISOString(),
          content,
        };
        const receiver = this.receivers.get(recipientInboxId);
        if (receiver) queueMicrotask(() => void receiver(message).catch(() => {}));
        else (this.backlog.get(recipientInboxId) ?? this.createBacklog(recipientInboxId)).push(message);
        return message.id;
      },
      start: async (onMessage) => {
        if (closed) throw new Error('control transport is closed');
        this.receivers.set(inboxId, onMessage);
        for (const message of this.backlog.get(inboxId) ?? []) await onMessage(message);
        this.backlog.delete(inboxId);
      },
      close: async () => { closed = true; this.receivers.delete(inboxId); },
    };
  }

  private createBacklog(inboxId: string): ControlTransportMessage[] {
    const messages: ControlTransportMessage[] = [];
    this.backlog.set(inboxId, messages);
    return messages;
  }
}

async function loadOrCreateIdentity(directory: string, name: string): Promise<StoredTransportIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const path = join(directory, `${name}-transport.json`);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredTransportIdentity;
    if (parsed.v !== 1 || Buffer.from(parsed.privateKeyB64, 'base64').byteLength !== 32 || Buffer.from(parsed.databaseKeyB64, 'base64').byteLength !== 32) {
      throw new Error('invalid XMTP control identity');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let privateKey = randomBytes(32);
  while (!secp256k1.utils.isValidSecretKey(privateKey)) privateKey = randomBytes(32);
  const identity: StoredTransportIdentity = {
    v: 1,
    privateKeyB64: privateKey.toString('base64'),
    databaseKeyB64: randomBytes(32).toString('base64'),
  };
  privateKey.fill(0);
  await writeFile(path, `${canonicalJson(identity)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return identity;
}

function signXmtpMessage(privateKey: Uint8Array, message: string): Uint8Array {
  const recognizedHeader = message.startsWith('XMTP : Authenticate to inbox\n') || message.startsWith('XMTP : Create Identity\n');
  const recognizedFooter = /\n\nFor more info: https:\/\/xmtp\.org\/signatures\/?$/.test(message);
  if (!recognizedHeader || !recognizedFooter || message.length > 16 * 1024 || message.includes('\0')) throw new Error('refusing non-XMTP signature text');
  const bytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const signature = secp256k1.sign(keccak_256(concatBytes(prefix, bytes)), privateKey, { prehash: false, format: 'recovered' });
  return Uint8Array.from([...signature.slice(1), signature[0]! + 27]);
}
