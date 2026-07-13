import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, type ClientOptions, type DecodedMessage, type Signer, type XmtpEnv } from '@xmtp/node-sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { mosaicRuntimeDirectory, type MosaicNetwork, type XmtpResourceDescriptor } from '@mosaic/local-runtime';

export interface XmtpInboundMessage {
  resourceId: string;
  messageId: string;
  sentAt: string;
  text: string;
}

export interface AgentXmtpClient {
  readonly address: string;
  send(resourceId: string, text: string): Promise<{ messageId: string }>;
  start(onMessage: (message: XmtpInboundMessage) => Promise<void>): Promise<void>;
  updateResources(resources: XmtpResourceDescriptor[]): Promise<void>;
  acknowledge(messageId: string): Promise<void>;
  close(): Promise<void>;
}

function signEip191(privateKey: Uint8Array, message: string): Uint8Array {
  const recognizedHeader = message.startsWith('XMTP : Authenticate to inbox\n') || message.startsWith('XMTP : Create Identity\n');
  const recognizedFooter = /\n\nFor more info: https:\/\/xmtp\.org\/signatures\/?$/.test(message);
  if (!recognizedHeader || !recognizedFooter || message.length > 16 * 1024 || message.includes('\0')) throw new Error('refusing non-XMTP signature text');
  const bytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const signature = secp256k1.sign(keccak_256(concatBytes(prefix, bytes)), privateKey, { prehash: false, format: 'recovered' });
  return Uint8Array.from([...signature.slice(1), signature[0]! + 27]);
}

export async function createAgentXmtpClient(params: {
  agentId: string;
  network: MosaicNetwork;
  address: string;
  ownerKey: Uint8Array;
  databaseKey: Uint8Array;
  resources: XmtpResourceDescriptor[];
}): Promise<AgentXmtpClient> {
  const env: XmtpEnv = params.network === 'testnet' ? 'dev' : 'production';
  const root = join(mosaicRuntimeDirectory(), 'agents', params.agentId, 'xmtp');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () => ({ identifier: params.address.toLowerCase(), identifierKind: 0 }),
    signMessage: async (message) => signEip191(params.ownerKey, message),
  };
  const client = await Client.create(signer, {
    env,
    appVersion: 'mosaic-supervisor/2.0.0',
    dbPath: (inboxId) => join(root, `${env}-${inboxId}.db3`),
    dbEncryptionKey: params.databaseKey,
  } as ClientOptions);
  const byResource = new Map<string, XmtpResourceDescriptor>();
  const resourceByInbox = new Map<string, string>();
  const updateResources = async (resources: XmtpResourceDescriptor[]) => {
    byResource.clear();
    resourceByInbox.clear();
    for (const resource of resources) {
      byResource.set(resource.resourceId, resource);
      const inboxId = await client.fetchInboxIdByIdentifier({ identifier: resource.peerAddress.toLowerCase(), identifierKind: 0 });
      if (inboxId) resourceByInbox.set(inboxId, resource.resourceId);
    }
  };
  await updateResources(params.resources);
  let closed = false;
  let stream: Awaited<ReturnType<typeof client.conversations.streamAllMessages>> | undefined;
  let streamTask: Promise<void> | undefined;
  return {
    address: params.address,
    async send(resourceId, text) {
      const resource = byResource.get(resourceId);
      if (!resource) throw new Error(`XMTP resource is not granted: ${resourceId}`);
      if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) throw new Error('XMTP message is invalid or too large');
      const dm = await client.conversations.createDmWithIdentifier({ identifier: resource.peerAddress.toLowerCase(), identifierKind: 0 });
      return { messageId: await dm.sendText(text) };
    },
    async start(onMessage) {
      if (streamTask) return;
      stream = await client.conversations.streamAllMessages();
      streamTask = (async () => {
        for await (const raw of stream!) {
          if (closed) break;
          const message = raw as DecodedMessage;
          const resourceId = resourceByInbox.get(message.senderInboxId);
          if (!resourceId || typeof message.content !== 'string') continue;
          await onMessage({ resourceId, messageId: message.id, sentAt: message.sentAt.toISOString(), text: message.content });
        }
      })();
      void streamTask.catch(() => {});
    },
    updateResources,
    async acknowledge(messageId) {
      await writeFile(join(root, 'delivery-cursor'), `${messageId}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    async close() {
      closed = true;
      await stream?.return?.();
      await streamTask?.catch(() => {});
    },
  };
}
