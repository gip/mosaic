import { deriveEvmAgentKey, deriveStellarAgentKey, deriveXrplAgentKey, zoneSeed, type ZoneRef } from '@mosaic/zone-keys';
import { api, type AuthVerifyResult, type TransferPrepareResult, type XamanRefs } from '../../api';
import { readCachedZoneSecret } from '../../zone/cache';
import type { WalletAccount } from '../../hooks/useWalletAccounts';

export interface TransferSigningUi {
  signRootStellarTransaction: (xdr: string) => Promise<string>;
  sendRootEvmTransaction: (transaction: Record<string, unknown>) => Promise<string>;
  showXaman: (refs: XamanRefs, cancel: () => void) => void;
  hideXaman: () => void;
}

async function signVault(prepared: TransferPrepareResult, account: Extract<WalletAccount, { kind: 'vault' }>, session: AuthVerifyResult) {
  const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: account.zone, network: session.network };
  const secret = await readCachedZoneSecret(ref, account.commitment);
  if (!secret) throw new Error(`Unlock ${account.zone} again before signing.`);
  let seed: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  try {
    seed = zoneSeed(secret, ref);
    const key = account.chain === 'xrpl' ? deriveXrplAgentKey(seed, account.index)
      : account.chain === 'stellar' ? deriveStellarAgentKey(seed, account.index)
        : deriveEvmAgentKey(seed, account.index);
    privateKey = key.privateKey;
    publicKey = key.publicKey;
    if (key.address.toLowerCase() !== account.address.toLowerCase()) throw new Error('Derived signing key does not match the selected registered address.');
    if (prepared.signingRequest.kind === 'xrpl' && account.chain === 'xrpl') {
      const { signXrplTransaction } = await import('@mosaic/xrpl');
      const signed = signXrplTransaction(prepared.signingRequest.unsignedTransaction as Parameters<typeof signXrplTransaction>[0], privateKey, publicKey);
      return { kind: 'xrpl' as const, txBlob: signed.txBlob };
    }
    if (prepared.signingRequest.kind === 'stellar' && account.chain === 'stellar') {
      const { signStellarTransaction } = await import('@mosaic/stellar');
      return { kind: 'stellar' as const, signedXdr: signStellarTransaction(prepared.signingRequest.unsignedXdr, session.network, privateKey) };
    }
    if (prepared.signingRequest.kind === 'evm' && account.chain === 'evm') {
      const { signEvmTransfer } = await import('@mosaic/evm');
      const serializedTransaction = await signEvmTransfer(
        prepared.signingRequest.transaction as unknown as Parameters<typeof signEvmTransfer>[0], privateKey,
      );
      return { kind: 'evm-raw' as const, serializedTransaction };
    }
    throw new Error('The signing request does not match the selected vault account.');
  } finally {
    secret.fill(0); seed?.fill(0); privateKey?.fill(0); publicKey?.fill(0);
  }
}

export async function signAndSubmitTransfer(
  prepared: TransferPrepareResult,
  account: WalletAccount,
  session: AuthVerifyResult,
  ui: TransferSigningUi,
) {
  if (prepared.signingRequest.kind === 'xaman') {
    const abort = new AbortController();
    ui.showXaman(prepared.signingRequest, () => abort.abort());
    try {
      const { watchXamanPayload } = await import('@mosaic/web-connector/xrpl');
      const watched = await watchXamanPayload(prepared.signingRequest.websocketStatus, { signal: abort.signal });
      if (!watched.signed) throw new Error(watched.expired ? 'The Xaman transfer request expired.' : 'The transfer was declined in Xaman.');
      return api.transferSubmit(session.token, prepared.transfer.id, { kind: 'xaman', payloadUuid: prepared.signingRequest.uuid });
    } finally {
      ui.hideXaman();
    }
  }
  if (account.kind === 'vault') return api.transferSubmit(session.token, prepared.transfer.id, await signVault(prepared, account, session));
  if (prepared.signingRequest.kind === 'stellar') {
    const signedXdr = await ui.signRootStellarTransaction(prepared.signingRequest.unsignedXdr);
    return api.transferSubmit(session.token, prepared.transfer.id, { kind: 'stellar', signedXdr });
  }
  if (prepared.signingRequest.kind === 'evm') {
    const transactionHash = await ui.sendRootEvmTransaction(prepared.signingRequest.transaction);
    return api.transferSubmit(session.token, prepared.transfer.id, { kind: 'evm-wallet', transactionHash });
  }
  throw new Error('This root wallet cannot sign the prepared transfer.');
}
