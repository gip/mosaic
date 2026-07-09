import { XummSdk } from 'xumm-sdk';
import type { ZoneMessage } from '@mosaic/zone-keys';
import { xrplSignInTxJson } from '@mosaic/zone-keys/verify';
import { MosaicMcpError } from './errors.js';
import { envString } from './env.js';

/**
 * Server-side Xaman (xumm) payload proxy. The API secret lives ONLY here; the
 * browser receives payload UUIDs, QR PNG urls, and status websocket urls, and
 * asks this service for signed results.
 */

export interface XamanPayloadRefs {
  uuid: string;
  qrPng: string;
  websocketStatus: string;
  deeplink: string;
}

export interface XamanPayloadResult {
  uuid: string;
  signed: boolean;
  resolved: boolean;
  /** Signed transaction blob (hex) when signed. */
  hex?: string;
  /** The r-address that signed. */
  account?: string;
}

export interface XamanService {
  createSignInPayload(message: ZoneMessage, instruction: string): Promise<XamanPayloadRefs>;
  getPayloadResult(uuid: string): Promise<XamanPayloadResult>;
}

export class XummXamanService implements XamanService {
  private readonly sdk: XummSdk;

  constructor(apiKey: string, apiSecret: string) {
    this.sdk = new XummSdk(apiKey, apiSecret);
  }

  async createSignInPayload(message: ZoneMessage, instruction: string): Promise<XamanPayloadRefs> {
    const txjson = xrplSignInTxJson(message);
    let created;
    try {
      // returnErrors=true: without it the sdk swallows Xaman API errors and
      // resolves null, hiding the actual rejection reason.
      created = await this.sdk.payload.create(
        {
          txjson,
          custom_meta: { instruction: instruction.slice(0, 280) },
        } as unknown as Parameters<XummSdk['payload']['create']>[0],
        true,
      );
    } catch (error) {
      throw new MosaicMcpError('XAMAN_UNAVAILABLE', `Xaman payload create failed: ${String(error)}`, { cause: error });
    }
    if (!created) throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman payload create returned nothing');
    return {
      uuid: created.uuid,
      qrPng: created.refs.qr_png,
      websocketStatus: created.refs.websocket_status,
      deeplink: created.next.always,
    };
  }

  async getPayloadResult(uuid: string): Promise<XamanPayloadResult> {
    let payload;
    try {
      payload = await this.sdk.payload.get(uuid);
    } catch (error) {
      throw new MosaicMcpError('XAMAN_UNAVAILABLE', `Xaman payload get failed: ${String(error)}`, { cause: error });
    }
    if (!payload) throw new MosaicMcpError('NOT_FOUND', `unknown Xaman payload: ${uuid}`);
    return {
      uuid,
      signed: payload.meta.signed === true,
      resolved: payload.meta.resolved === true,
      hex: payload.response?.hex ?? undefined,
      account: payload.response?.account ?? undefined,
    };
  }
}

export function xamanServiceFromEnv(): XamanService | undefined {
  const key = envString('XAMAN_API_KEY');
  const secret = envString('XAMAN_API_SECRET');
  if (!key || !secret) return undefined;
  return new XummXamanService(key, secret);
}
