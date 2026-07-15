import {
  EVM_CHAIN_IDS,
  eip712TypedData,
  toEip55,
  type Network,
  type ZoneMessage,
} from '@mosaic/zone-keys';
import type { SignedZoneMessage } from '../types.js';

/** Minimal EIP-1193 surface we need (viem's type is heavier than necessary). */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}

// ------------------------------------------------------------ EIP-6963

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/**
 * Discover installed EVM wallet extensions (EIP-6963 announce/request
 * events). Resolves after `timeoutMs` with whatever announced.
 */
export function discoverEvmExtensions(timeoutMs = 300): Promise<Eip6963ProviderDetail[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Eip6963ProviderDetail>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (detail?.info?.uuid) found.set(detail.info.uuid, detail);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

export async function requestEvmAccount(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error('wallet returned no account');
  return toEip55(address);
}

// -------------------------------------------------------- WalletConnect

/**
 * EVM over WalletConnect v2 with our own QR: `showQrModal: false` and the
 * pairing uri surfaced through `onDisplayUri` for the login tile to render.
 * This is the default (mobile-wallet) path; MetaMask mobile scans the QR.
 * Lazy-imports the provider lib so extension-only users never download it.
 */
/**
 * One provider per page (keyed by chain, which is baked into init): every
 * init replays the persisted `wc@2:*` storage, so per-attempt providers race
 * each other's cleanup and process relay messages for sessions only another
 * instance knows ("No matching key" console errors).
 */
type WcEthereumProvider = Awaited<
  ReturnType<(typeof import('@walletconnect/ethereum-provider'))['EthereumProvider']['init']>
>;
const wcProviderPromises = new Map<number, Promise<WcEthereumProvider>>();

async function getWcProvider(projectId: string, chainId: number): Promise<WcEthereumProvider> {
  let promise = wcProviderPromises.get(chainId);
  if (!promise) {
    promise = (async () => {
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      return EthereumProvider.init({
        projectId,
        // Partition wc@2 storage away from the Stellar connector's client:
        // two cores over the same keys overwrite each other's
        // pairing/session state ("Restore will override", lost proposals on
        // approval).
        customStoragePrefix: 'mosaic-evm',
        chains: [chainId],
        // Wallets omit chains they don't have enabled (Base Sepolia is off
        // by default in MetaMask), and WalletConnect treats every requested
        // chain as optional — so also ask for Ethereum mainnet, which every
        // wallet has, to guarantee the session carries an account.
        // ensureEvmChain() then switches/adds the target chain before
        // signing, which needs the wallet_*EthereumChain methods.
        optionalChains: [1],
        showQrModal: false,
        methods: ['eth_signTypedData_v4'],
        optionalMethods: ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_sendTransaction'],
        events: ['accountsChanged', 'chainChanged'],
      });
    })().catch((err) => {
      wcProviderPromises.delete(chainId);
      throw err;
    });
    wcProviderPromises.set(chainId, promise);
  }
  return promise;
}

export async function connectEvmWalletConnect(opts: {
  projectId: string;
  network: Network;
  onDisplayUri: (uri: string) => void;
}): Promise<{ provider: Eip1193Provider; address: string }> {
  const chainId = EVM_CHAIN_IDS[opts.network];
  const provider = await getWcProvider(opts.projectId, chainId);
  provider.on('display_uri', opts.onDisplayUri);
  try {
    await provider.connect();
  } finally {
    provider.removeListener('display_uri', opts.onDisplayUri);
  }
  const address = provider.accounts[0];
  if (!address) {
    throw new Error('The wallet approved the session without an account — enable the requested network in the wallet and retry.');
  }
  return { provider: provider as unknown as Eip1193Provider, address: toEip55(address) };
}

/**
 * Wrap a WalletConnect pairing uri in MetaMask's universal link. A QR of the
 * bare `wc:` uri gets routed by the phone OS to whichever wallet app owns
 * that scheme; the universal link pins the scan to MetaMask mobile.
 */
export function metamaskWcLink(uri: string): string {
  return `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`;
}

// ---------------------------------------------------------- Chain switch

/** wallet_addEthereumChain params for chains the wallet may not know yet. */
const EVM_CHAIN_PARAMS: Record<number, Record<string, unknown>> = {
  8453: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  84532: {
    chainId: '0x14a34',
    chainName: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorerUrls: ['https://sepolia.basescan.org'],
  },
};

/**
 * MetaMask rejects eth_signTypedData_v4 when the typed-data domain chainId
 * differs from the wallet's active chain, so switch (or add) the target
 * chain before asking for a signature.
 */
export async function ensureEvmChain(provider: Eip1193Provider, network: Network): Promise<void> {
  const target = EVM_CHAIN_IDS[network];
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === target) return;
  const chainIdHex = `0x${target.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  } catch (err) {
    // 4902: chain not added to the wallet yet
    if ((err as { code?: number } | null)?.code === 4902 && EVM_CHAIN_PARAMS[target]) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [EVM_CHAIN_PARAMS[target]] });
    } else {
      throw err;
    }
  }
}

// --------------------------------------------------------------- Signing

/**
 * Full eth_signTypedData_v4 payload. Unlike viem's high-level signer, the raw
 * RPC call requires the EIP712Domain type to be present in `types`.
 */
export function evmSignTypedDataPayload(message: ZoneMessage, network: Network): {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: ZoneMessage;
} {
  const typed = eip712TypedData(message, EVM_CHAIN_IDS[network]);
  return {
    domain: typed.domain as unknown as Record<string, unknown>,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      ...(typed.types as Record<string, { name: string; type: string }[]>),
    },
    primaryType: typed.primaryType,
    message,
  };
}

export async function signEvmZoneMessage(
  provider: Eip1193Provider,
  address: string,
  message: ZoneMessage,
  network: Network,
): Promise<SignedZoneMessage> {
  await ensureEvmChain(provider, network);
  const payload = evmSignTypedDataPayload(message, network);
  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(payload)],
  })) as `0x${string}`;
  if (!signature?.startsWith('0x')) throw new Error('wallet returned no signature');
  return {
    signatureBytes: hexToBytes(signature),
    envelope: { type: 'evm', signature },
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
