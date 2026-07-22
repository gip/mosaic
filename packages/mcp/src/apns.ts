import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { connect } from 'node:http2';
import { envString } from './env.js';

/**
 * Token-based APNs sender (ES256 provider JWT over HTTP/2, node:http2 — no
 * extra dependencies). Payloads are CONTENT-FREE by design: a wake-up alert
 * plus a category; no zone, agent, or amount data ever transits APNs.
 *
 * Configuration (all required to enable; otherwise `configured` is false and
 * push_notify degrades to a no-op):
 *   MOSAIC_APNS_TEAM_ID    Apple developer team id
 *   MOSAIC_APNS_KEY_ID     .p8 key id
 *   MOSAIC_APNS_KEY_P8     the .p8 PEM contents (or base64 of it)
 *   MOSAIC_APNS_BUNDLE_ID  apns-topic (app bundle id)
 */

export type ApnsEnvironment = 'development' | 'production';

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};

export interface ApnsSendResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface ApnsService {
  readonly configured: boolean;
  send(deviceToken: string, environment: ApnsEnvironment, alert: { title: string; body: string; category: string }): Promise<ApnsSendResult>;
}

const JWT_TTL_MS = 45 * 60_000; // Apple allows 20-60 minutes; refresh at 45.

export class TokenApnsService implements ApnsService {
  readonly configured = true;
  private readonly key: KeyObject;
  private jwt?: { token: string; issuedAt: number };

  constructor(
    private readonly teamId: string,
    private readonly keyId: string,
    keyPem: string,
    private readonly bundleId: string,
  ) {
    this.key = createPrivateKey(keyPem);
  }

  private providerToken(): string {
    const now = Date.now();
    if (this.jwt && now - this.jwt.issuedAt < JWT_TTL_MS) return this.jwt.token;
    const b64url = (data: string | Buffer): string =>
      Buffer.from(data).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const payload = b64url(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) }));
    const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${header}.${payload}.${b64url(signature)}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  async send(
    deviceToken: string,
    environment: ApnsEnvironment,
    alert: { title: string; body: string; category: string },
  ): Promise<ApnsSendResult> {
    const body = JSON.stringify({
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: 'default',
        category: alert.category,
        'mutable-content': 0,
      },
    });
    return new Promise((resolve) => {
      const client = connect(HOSTS[environment]);
      client.on('error', (error) => resolve({ ok: false, reason: String(error) }));
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', (error) => {
        client.close();
        resolve({ ok: false, reason: String(error) });
      });
      request.on('end', () => {
        client.close();
        if (status === 200) {
          resolve({ ok: true, status });
        } else {
          let reason: string | undefined;
          try {
            reason = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }).reason;
          } catch {
            reason = undefined;
          }
          resolve({ ok: false, status, reason });
        }
      });
      request.end(body);
    });
  }
}

class DisabledApnsService implements ApnsService {
  readonly configured = false;

  send(): Promise<ApnsSendResult> {
    return Promise.resolve({ ok: false, reason: 'APNs is not configured' });
  }
}

export function apnsServiceFromEnv(): ApnsService {
  const teamId = envString('MOSAIC_APNS_TEAM_ID');
  const keyId = envString('MOSAIC_APNS_KEY_ID');
  const rawKey = envString('MOSAIC_APNS_KEY_P8');
  const bundleId = envString('MOSAIC_APNS_BUNDLE_ID');
  if (!teamId || !keyId || !rawKey || !bundleId) return new DisabledApnsService();
  const keyPem = rawKey.includes('-----BEGIN') ? rawKey : Buffer.from(rawKey, 'base64').toString('utf8');
  return new TokenApnsService(teamId, keyId, keyPem, bundleId);
}

export { DisabledApnsService };
