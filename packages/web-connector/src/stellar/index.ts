import { canonicalJson, type Network, type ZoneMessage } from '@mosaic/zone-keys';
import type { SignedZoneMessage } from '../types.js';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
};

const WC_CHAIN_IDS: Record<Network, string> = {
  mainnet: 'stellar:pubnet',
  testnet: 'stellar:testnet',
};

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let s = '';
  for (const byte of value) s += String.fromCharCode(byte);
  return btoa(s);
}

// --------------------------------------------------------------- Freighter

export async function freighterInstalled(): Promise<boolean> {
  try {
    const { isConnected } = await import('@stellar/freighter-api');
    return Boolean((await isConnected()).isConnected);
  } catch {
    return false;
  }
}

export async function connectFreighter(): Promise<string> {
  const { requestAccess } = await import('@stellar/freighter-api');
  const result = await requestAccess();
  if (result.error) throw new Error(String(result.error));
  if (!result.address) throw new Error('Freighter returned no address');
  return result.address;
}

/** Freighter signs the canonical JSON string per SEP-53. */
export async function signStellarZoneMessageWithFreighter(
  address: string,
  message: ZoneMessage,
  network: Network,
): Promise<SignedZoneMessage> {
  const { signMessage } = await import('@stellar/freighter-api');
  const result = await signMessage(canonicalJson(message), {
    address,
    networkPassphrase: NETWORK_PASSPHRASES[network],
  });
  if (result.error) throw new Error(String(result.error));
  if (!result.signedMessage) throw new Error('Freighter returned no signed message');
  const signatureBytes =
    typeof result.signedMessage === 'string'
      ? base64ToBytes(result.signedMessage)
      : new Uint8Array(result.signedMessage);
  return {
    signatureBytes,
    envelope: { type: 'stellar', signatureB64: bytesToBase64(signatureBytes) },
  };
}

// ----------------------------------------------------------- WalletConnect

export interface StellarWalletConnectSession {
  address: string;
  signZoneMessage(message: ZoneMessage): Promise<SignedZoneMessage>;
  disconnect(): Promise<void>;
}

/**
 * Stellar over WalletConnect v2 (`stellar_signMessage`). This is the default
 * (mobile-wallet) path: Freighter mobile speaks WalletConnect only — the
 * extension has no QR pairing. Lobstr also supports it, but message-signing
 * support varies per wallet; callers must degrade gracefully to the Freighter
 * extension button when the request is rejected as unsupported.
 */
/**
 * Wrap a WalletConnect pairing uri in Freighter mobile's deeplink. The
 * production app's redirect prefix is `freighterwallet://wc-redirect` (per
 * `mobile.native` in its WalletConnect registry listing); its deep-link
 * handler silently drops any url missing that prefix, then reads the `uri`
 * query param — so the link must carry both. A QR of the bare `wc:` uri gets
 * routed by the phone OS to whichever wallet app owns that scheme (often
 * MetaMask); the deeplink pins the scan to Freighter.
 */
export function freighterWcLink(uri: string): string {
  return `freighterwallet://wc-redirect/wc?uri=${encodeURIComponent(uri)}`;
}

/**
 * One SignClient per page: every init replays the persisted `wc@2:*` storage,
 * so per-attempt clients race each other's cleanup and log spurious
 * "No matching key" errors for proposals abandoned by earlier attempts.
 */
let signClientPromise: Promise<SignClientInstance> | undefined;
type SignClientInstance = Awaited<
  ReturnType<(typeof import('@walletconnect/sign-client'))['SignClient']['init']>
>;

async function getSignClient(projectId: string): Promise<SignClientInstance> {
  signClientPromise ??= (async () => {
    const { SignClient } = await import('@walletconnect/sign-client');
    return SignClient.init({
      projectId,
      // Partition wc@2 storage away from the EVM connector's provider: two
      // cores over the same keys overwrite each other's pairing/session
      // state ("Restore will override", lost proposals on approval).
      customStoragePrefix: 'mosaic-stellar',
      metadata: {
        name: 'Mosaic',
        description: 'Mosaic zone-derived agent wallets',
        url: window.location.origin,
        icons: [`${window.location.origin}/mosaic-logo.png`],
      },
    });
  })().catch((err) => {
    signClientPromise = undefined;
    throw err;
  });
  return signClientPromise;
}

export async function connectStellarWalletConnect(opts: {
  projectId: string;
  network: Network;
  onDisplayUri: (uri: string) => void;
}): Promise<StellarWalletConnectSession> {
  const chainId = WC_CHAIN_IDS[opts.network];
  const client = await getSignClient(opts.projectId);
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      stellar: {
        methods: ['stellar_signMessage'],
        chains: [chainId],
        events: [],
      },
    },
  });
  if (uri) opts.onDisplayUri(uri);
  const session = await approval();
  const account = session.namespaces.stellar?.accounts?.[0];
  const address = account?.split(':')[2];
  if (!address) throw new Error('WalletConnect session has no Stellar account');

  return {
    address,
    async signZoneMessage(message: ZoneMessage): Promise<SignedZoneMessage> {
      const result = (await client.request({
        topic: session.topic,
        chainId,
        request: {
          method: 'stellar_signMessage',
          params: { message: canonicalJson(message) },
        },
      })) as { signedMessage?: string; signature?: string };
      const signed = result.signedMessage ?? result.signature;
      if (!signed) throw new Error('wallet returned no signed message');
      const signatureBytes = base64ToBytes(signed);
      return { signatureBytes, envelope: { type: 'stellar', signatureB64: signed } };
    },
    async disconnect(): Promise<void> {
      await client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: 'user logout' },
      });
    },
  };
}
