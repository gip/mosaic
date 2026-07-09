import type { Eip1193Provider } from '@mosaic/web-connector/evm';

/**
 * Dev-only in-page EVM wallet (enabled via VITE_DEMO_WALLET=<0x-privkey>).
 * Implements just enough EIP-1193 to drive the real login + ceremony flows
 * end-to-end in QA — deterministic RFC-6979 signatures, so the determinism
 * self-test passes exactly like MetaMask software keys. Never ship real funds
 * on this key.
 */
export async function createDemoProvider(privateKey: `0x${string}`): Promise<{
  address: string;
  provider: Eip1193Provider;
}> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey);
  let chainId = '0x14a34'; // Base Sepolia; switch requests are honored blindly
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = (params as [{ chainId: string }])[0].chainId;
        return null;
      }
      if (method === 'eth_signTypedData_v4') {
        const [, payload] = params as [string, string];
        const typed = JSON.parse(payload) as {
          domain: Record<string, unknown>;
          types: Record<string, { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
        // viem derives the EIP712Domain type from `domain` itself.
        delete typed.types['EIP712Domain'];
        return account.signTypedData(typed as Parameters<typeof account.signTypedData>[0]);
      }
      throw new Error(`demo provider: unsupported method ${method}`);
    },
  };
  return { address: account.address, provider };
}
