import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { SignClient } from '@walletconnect/sign-client';
import { renderUnicodeCompact } from 'uqr';
import { backupWrapMessage, canonicalJson, type Network, type RootChain, type ZoneRef } from '@mosaic/zone-keys';
import {
  connectEvmWalletConnect,
  metamaskWcLink,
  signEvmZoneMessage,
  type Eip1193Provider,
} from '@mosaic/web-connector/evm';
import { freighterWcLink } from '@mosaic/web-connector/stellar';
import { watchXamanPayload } from '@mosaic/web-connector/xrpl';
import { McpGuardianApi, type GuardianSession } from './service.js';

export interface CliLogin {
  session: GuardianSession;
  signBackupWrap?: (ref: ZoneRef) => Promise<Uint8Array>;
}

export async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY) throw new Error(`${label} requires an interactive terminal`);
  stdout.write(`${label}: `);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await prompt.question('')).trim(); }
  finally { prompt.close(); stdout.write('\n'); }
}

function showQr(uri: string, label: string): void {
  console.log(`\n${label}`);
  console.log(renderUnicodeCompact(uri, { border: 2 }));
  console.log(uri);
}

async function chooseChain(): Promise<RootChain> {
  const configured = process.env.MOSAIC_ROOT_CHAIN;
  if (configured === 'evm' || configured === 'xrpl' || configured === 'stellar') return configured;
  if (!stdin.isTTY) throw new Error('Set MOSAIC_ROOT_CHAIN to evm, xrpl, or stellar for non-interactive Guardian login');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question('Root wallet [1 Xaman / 2 MetaMask / 3 Freighter]: ')).trim().toLowerCase();
    if (answer === '1' || answer === 'xrpl' || answer === 'xaman') return 'xrpl';
    if (answer === '2' || answer === 'evm' || answer === 'metamask') return 'evm';
    if (answer === '3' || answer === 'stellar' || answer === 'freighter') return 'stellar';
    throw new Error('unknown wallet selection');
  } finally { prompt.close(); }
}

export async function loginFromCli(api: McpGuardianApi, network: Network): Promise<CliLogin> {
  const chain = await chooseChain();
  if (chain === 'xrpl') return loginXrpl(api, network);
  const projectId = process.env.MOSAIC_WALLETCONNECT_PROJECT_ID || process.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) throw new Error('Set MOSAIC_WALLETCONNECT_PROJECT_ID to use MetaMask or Freighter QR login');
  return chain === 'evm' ? loginEvm(api, network, projectId) : loginStellar(api, network, projectId);
}

async function loginXrpl(api: McpGuardianApi, network: Network): Promise<CliLogin> {
  const challenge = await api.authChallenge({ chain: 'xrpl', network });
  if (!challenge.xaman) throw new Error('MCP server has no Xaman configuration');
  showQr(challenge.xaman.deeplink, 'Scan with Xaman');
  const result = await watchXamanPayload(challenge.xaman.websocketStatus);
  if (!result.signed) throw new Error(result.expired ? 'Xaman login expired' : 'Xaman login declined');
  return { session: await api.authVerify({ challengeId: challenge.challengeId }) };
}

async function loginEvm(api: McpGuardianApi, network: Network, projectId: string): Promise<CliLogin> {
  let provider: Eip1193Provider;
  let address: string;
  ({ provider, address } = await connectEvmWalletConnect({
    projectId,
    network,
    onDisplayUri: (uri) => showQr(metamaskWcLink(uri), 'Scan with MetaMask'),
  }));
  const challenge = await api.authChallenge({ chain: 'evm', network, address });
  const signed = await signEvmZoneMessage(provider, address, challenge.message, network);
  const session = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope as unknown as Record<string, unknown> });
  return {
    session,
    signBackupWrap: async (ref) => (await signEvmZoneMessage(provider, address, backupWrapMessage(ref), network)).signatureBytes,
  };
}

async function loginStellar(api: McpGuardianApi, network: Network, projectId: string): Promise<CliLogin> {
  const chainId = network === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet';
  const client = await SignClient.init({
    projectId,
    customStoragePrefix: 'mosaic-guardian-stellar',
    metadata: {
      name: 'Mosaic Guardian',
      description: 'Local Mosaic vault guardian',
      url: 'https://mosaic.local',
      icons: [],
    },
  });
  const { uri, approval } = await client.connect({
    requiredNamespaces: { stellar: { methods: ['stellar_signMessage'], chains: [chainId], events: [] } },
  });
  if (uri) showQr(freighterWcLink(uri), 'Scan with Freighter');
  const wcSession = await approval();
  const address = wcSession.namespaces.stellar?.accounts?.[0]?.split(':')[2];
  if (!address) throw new Error('Freighter session has no Stellar address');

  const sign = async (message: object): Promise<{ bytes: Uint8Array; envelope: { type: 'stellar'; signatureB64: string } }> => {
    const result = await client.request({
      topic: wcSession.topic,
      chainId,
      request: { method: 'stellar_signMessage', params: { message: canonicalJson(message) } },
    }) as { signedMessage?: string; signature?: string };
    const signatureB64 = result.signedMessage ?? result.signature;
    if (!signatureB64) throw new Error('Freighter returned no signature');
    return { bytes: new Uint8Array(Buffer.from(signatureB64, 'base64')), envelope: { type: 'stellar', signatureB64 } };
  };
  const challenge = await api.authChallenge({ chain: 'stellar', network, address });
  const signed = await sign(challenge.message);
  const session = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope });
  return { session, signBackupWrap: async (ref) => (await sign(backupWrapMessage(ref))).bytes };
}
