import { deriveStellarAgentKey, deriveXrplAgentKey, zoneSeed, type ZoneRef } from '@mosaic/zone-keys';
import { api, type AuthVerifyResult, type DexOrderPrepareResult, type XamanRefs } from '../../api';
import { readCachedZoneSecret } from '../../zone/cache';
import type { TradingAccount } from '../../hooks/useTradingAccounts';

export interface DexSigningUi {
  signRootStellarTransaction: (xdr: string) => Promise<string>;
  showXaman: (refs: XamanRefs) => void;
  hideXaman: () => void;
}

async function signVault(prepared: DexOrderPrepareResult, account: Extract<TradingAccount, { kind: 'vault' }>, session: AuthVerifyResult) {
  const ref: ZoneRef = {
    rootChain: session.chain,
    rootAddress: session.address,
    zone: account.zone,
    network: session.network,
  };
  const secret = await readCachedZoneSecret(ref, account.commitment);
  if (!secret) throw new Error(`Unlock ${account.zone} again before signing.`);
  let seed: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  try {
    seed = zoneSeed(secret, ref);
    const key = account.chain === 'xrpl'
      ? deriveXrplAgentKey(seed, account.index)
      : deriveStellarAgentKey(seed, account.index);
    privateKey = key.privateKey;
    publicKey = key.publicKey;
    if (key.address !== account.address) throw new Error('Derived signing key does not match the selected registered address.');
    if (prepared.signingRequest.kind === 'xrpl' && account.chain === 'xrpl') {
      const { signXrplTransaction } = await import('@mosaic/xrpl');
      const signed = signXrplTransaction(
        prepared.signingRequest.unsignedTransaction as Parameters<typeof signXrplTransaction>[0],
        privateKey,
        publicKey,
      );
      return { kind: 'xrpl' as const, txBlob: signed.txBlob };
    }
    if (prepared.signingRequest.kind === 'stellar' && account.chain === 'stellar') {
      const { signStellarTransaction } = await import('@mosaic/stellar');
      return { kind: 'stellar' as const, signedXdr: signStellarTransaction(prepared.signingRequest.unsignedXdr, session.network, privateKey) };
    }
    throw new Error('The signing request does not match the selected vault account.');
  } finally {
    secret.fill(0);
    seed?.fill(0);
    privateKey?.fill(0);
    publicKey?.fill(0);
  }
}

export async function signAndSubmitOrder(
  prepared: DexOrderPrepareResult,
  account: TradingAccount,
  session: AuthVerifyResult,
  ui: DexSigningUi,
) {
  if (prepared.signingRequest.kind === 'xaman') {
    ui.showXaman(prepared.signingRequest);
    try {
      const { watchXamanPayload } = await import('@mosaic/web-connector/xrpl');
      const watched = await watchXamanPayload(prepared.signingRequest.websocketStatus);
      if (!watched.signed) throw new Error(watched.expired ? 'The Xaman order request expired.' : 'The order was declined in Xaman.');
      return api.dexOrderSubmit(session.token, prepared.order.id, { kind: 'xaman', payloadUuid: prepared.signingRequest.uuid });
    } finally {
      ui.hideXaman();
    }
  }
  if (account.kind === 'vault') {
    return api.dexOrderSubmit(session.token, prepared.order.id, await signVault(prepared, account, session));
  }
  if (prepared.signingRequest.kind !== 'stellar') throw new Error('This root wallet cannot sign the prepared transaction.');
  const signedXdr = await ui.signRootStellarTransaction(prepared.signingRequest.unsignedXdr);
  return api.dexOrderSubmit(session.token, prepared.order.id, { kind: 'stellar', signedXdr });
}
