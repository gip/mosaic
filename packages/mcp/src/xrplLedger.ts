import type { Network } from '@mosaic/zone-keys';
import { MosaicMcpError } from './errors.js';
import { envString } from './env.js';

/**
 * XRPL authoritative-key check (spec §2.3): a SignIn signature is accepted
 * only if the key that produced it is CURRENTLY authoritative for the account
 * on the ledger — master key (not disabled), the RegularKey, or a SignerList
 * member. Merely matching the embedded SigningPubKey is not enough.
 */

const DEFAULT_RPC: Record<Network, string> = {
  mainnet: 'https://xrplcluster.com',
  testnet: 'https://s.altnet.rippletest.net:51234',
};

const LSF_DISABLE_MASTER = 0x00100000;

export function xrplRpcUrl(network: Network): string {
  const override = envString(network === 'mainnet' ? 'MOSAIC_XRPL_RPC_MAINNET' : 'MOSAIC_XRPL_RPC_TESTNET');
  return override ?? DEFAULT_RPC[network];
}

async function rpc(network: Network, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(xrplRpcUrl(network), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new MosaicMcpError('LEDGER_UNAVAILABLE', `XRPL RPC unreachable: ${String(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new MosaicMcpError('LEDGER_UNAVAILABLE', `XRPL RPC ${response.status}`);
  }
  const body = (await response.json()) as { result?: Record<string, unknown> };
  return body.result ?? {};
}

export interface XrplAuthorityCheck {
  authoritative: boolean;
  reason: string;
}

/**
 * Is `signerAddress` currently allowed to sign for `account`?
 * Unfunded accounts have no ledger entry: only the master key (== the account
 * itself) can be authoritative there.
 */
export async function checkXrplSignerAuthority(
  account: string,
  signerAddress: string,
  network: Network,
): Promise<XrplAuthorityCheck> {
  const info = await rpc(network, 'account_info', {
    account,
    ledger_index: 'validated',
    signer_lists: true,
  });

  if (info.error === 'actNotFound') {
    return signerAddress === account
      ? { authoritative: true, reason: 'unfunded account, master key' }
      : { authoritative: false, reason: 'unfunded account: only the master key is authoritative' };
  }
  if (info.error) {
    throw new MosaicMcpError('LEDGER_UNAVAILABLE', `account_info error: ${String(info.error)}`);
  }

  const accountData = (info.account_data ?? {}) as {
    Flags?: number;
    RegularKey?: string;
    signer_lists?: { SignerEntries?: { SignerEntry?: { Account?: string } }[] }[];
  };
  const flags = accountData.Flags ?? 0;
  const masterDisabled = (flags & LSF_DISABLE_MASTER) !== 0;

  if (signerAddress === account) {
    return masterDisabled
      ? { authoritative: false, reason: 'master key disabled' }
      : { authoritative: true, reason: 'master key' };
  }
  if (accountData.RegularKey === signerAddress) {
    return { authoritative: true, reason: 'regular key' };
  }
  const signerLists = accountData.signer_lists ?? [];
  for (const list of signerLists) {
    for (const entry of list.SignerEntries ?? []) {
      if (entry.SignerEntry?.Account === signerAddress) {
        return { authoritative: true, reason: 'signer list member' };
      }
    }
  }
  return { authoritative: false, reason: 'key is not master, regular key, or signer-list member' };
}
