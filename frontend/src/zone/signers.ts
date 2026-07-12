import { authorizeZoneMessage, backupWrapMessage, type ZoneMessage, type ZoneRef } from '@mosaic/zone-keys';
import type { SignedZoneMessage } from '@mosaic/web-connector/types';
import { api, type XamanRefs } from '../api';
import type { CeremonySigner } from './ceremony';

/** EVM/Stellar: the page holds a wallet handle that signs canonical messages. */
export function directCeremonySigner(
  ref: ZoneRef,
  signZoneMessage: (message: ZoneMessage) => Promise<SignedZoneMessage>,
): CeremonySigner {
  return {
    async signAuthorizeZone({ begin, ...fields }) {
      const message = authorizeZoneMessage(ref, {
        ...fields,
        nonce: begin.nonce,
        issuedAt: begin.issuedAt,
        expiresAt: begin.expiresAt,
      });
      const signed = await signZoneMessage(message);
      return signed.envelope;
    },
    async signBackupWrap() {
      const signed = await signZoneMessage(backupWrapMessage(ref));
      return signed.signatureBytes;
    },
  };
}

export interface XamanPromptHooks {
  /** Show a payload QR for the user to scan; label explains the step. */
  onPayload: (refs: XamanRefs, label: string) => void;
  /** Hide the QR once the payload resolves. */
  onPayloadDone: () => void;
}

/**
 * XRPL: every signature is a server-created Xaman SignIn payload. The page
 * renders the QR via the hooks; this signer waits on the status websocket and
 * fetches the signed blob through the MCP.
 */
export function xamanCeremonySigner(opts: { token: string; ref: ZoneRef } & XamanPromptHooks): CeremonySigner {
  async function signViaPayload(refs: XamanRefs, label: string): Promise<{ uuid: string; hex: string }> {
    opts.onPayload(refs, label);
    try {
      const { watchXamanPayload } = await import('@mosaic/web-connector/xrpl');
      const watched = await watchXamanPayload(refs.websocketStatus);
      if (!watched.signed) {
        throw new Error(watched.expired ? 'The Xaman request expired — try again.' : 'Signature request declined in Xaman.');
      }
      const result = await api.xamanPayloadResult(opts.token, refs.uuid);
      if (!result.signed || !result.hex) throw new Error('Xaman returned no signed payload');
      return { uuid: refs.uuid, hex: result.hex };
    } finally {
      opts.onPayloadDone();
    }
  }

  return {
    async signAuthorizeZone({ begin, ...fields }) {
      const refs = await api.xamanSignCreate({
        token: opts.token,
        purpose: 'authorize-zone',
        zone: opts.ref.zone,
        challengeId: begin.challengeId,
        ...fields,
      });
      const { uuid } = await signViaPayload(refs, 'Authorize the vault in Xaman');
      return { type: 'xrpl', payloadUuid: uuid };
    },
    async signBackupWrap() {
      const refs = await api.xamanSignCreate({ token: opts.token, purpose: 'backup-wrap', zone: opts.ref.zone });
      const { hex } = await signViaPayload(refs, 'Sign the backup key in Xaman');
      const { xrplTxnSignatureBytes } = await import('@mosaic/zone-keys/verify');
      return xrplTxnSignatureBytes(hex);
    },
  };
}
