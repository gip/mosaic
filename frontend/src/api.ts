import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Network, RootChain, SessionAuthMessage } from '@mosaic/zone-keys';
import { MCP_URL } from './config';

export type SignatureEnvelope =
  | { type: 'evm'; signature: `0x${string}` }
  | { type: 'stellar'; signatureB64: string }
  | { type: 'xrpl'; payloadUuid: string };

export interface XamanRefs {
  uuid: string;
  qrPng: string;
  websocketStatus: string;
  deeplink: string;
}

export interface AuthChallengeResult {
  challengeId: string;
  message: SessionAuthMessage;
  expiresAt: string;
  evmChainId?: number;
  xaman?: XamanRefs;
}

export interface AuthVerifyResult {
  token: string;
  chain: RootChain;
  address: string;
  network: Network;
  expiresAt: number;
}

export interface ZoneGetResult {
  exists: boolean;
  zoneId?: string;
  commitment?: string;
  policyHash?: string;
  localSignerPublicKey?: string;
  layer1Enabled?: boolean;
  createdAt?: string;
  blobs?: { kind: 'sig' | 'pass'; version: number }[];
}

export interface BlobGetResult {
  kind: 'sig' | 'pass';
  version: number;
  header: Record<string, unknown>;
  ciphertextB64: string;
  commitment: string;
}

class MosaicApi {
  private clientPromise: Promise<Client> | undefined;

  private connect(): Promise<Client> {
    this.clientPromise ??= (async () => {
      // Lazy: the MCP SDK is a large dependency and nothing needs it before
      // the first server call.
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      ]);
      const client = new Client({ name: 'mosaic-frontend', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
      return client;
    })().catch((error: unknown) => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    const text = content?.[0]?.text ?? '{}';
    const data = JSON.parse(text) as T & { error?: { message?: string } };
    if (result.isError) throw new Error(data.error?.message ?? `tool ${name} failed`);
    return data;
  }

  authChallenge(args: { chain: RootChain; network: Network; address?: string }): Promise<AuthChallengeResult> {
    return this.call('auth_challenge', args);
  }

  authVerify(args: { challengeId: string; signature?: SignatureEnvelope }): Promise<AuthVerifyResult> {
    return this.call('auth_verify', args);
  }

  authLogout(token: string): Promise<{ ok: boolean }> {
    return this.call('auth_logout', { token });
  }

  zoneBegin(token: string, zone: string): Promise<{ challengeId: string; nonce: string; issuedAt: string; expiresAt: string }> {
    return this.call('zone_begin', { token, zone });
  }

  zoneCreate(args: {
    token: string;
    challengeId: string;
    zone: string;
    localSignerPublicKey: string;
    policyHash: string;
    zoneRootCommitment: string;
    signature: SignatureEnvelope;
  }): Promise<{ zoneId: string; createdAt: string }> {
    return this.call('zone_create', args);
  }

  zoneGet(token: string, zone: string): Promise<ZoneGetResult> {
    return this.call('zone_get', { token, zone });
  }

  blobPut(args: {
    token: string;
    zone: string;
    kind: 'sig' | 'pass';
    ciphertextB64: string;
    header: Record<string, unknown>;
  }): Promise<{ version: number }> {
    return this.call('blob_put', args);
  }

  blobGet(token: string, zone: string, kind: 'sig' | 'pass'): Promise<BlobGetResult> {
    return this.call('blob_get', { token, zone, kind });
  }

  xamanSignCreate(args: {
    token: string;
    purpose: 'backup-wrap' | 'authorize-zone';
    zone: string;
    challengeId?: string;
    localSignerPublicKey?: string;
    policyHash?: string;
    zoneRootCommitment?: string;
  }): Promise<XamanRefs> {
    return this.call('xaman_sign_create', args);
  }

  xamanPayloadResult(token: string, uuid: string): Promise<{ signed: boolean; resolved: boolean; hex?: string; account?: string }> {
    return this.call('xaman_payload_result', { token, uuid });
  }
}

export const api = new MosaicApi();
