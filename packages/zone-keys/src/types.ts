/** Chains a root wallet can live on. */
export type RootChain = 'evm' | 'xrpl' | 'stellar';

/** Chains agent keys are derived for. */
export type AgentChain = 'evm' | 'xrpl' | 'stellar';

export type Network = 'mainnet' | 'testnet';

/** Identity of a zone. All four fields are derivation inputs. */
export interface ZoneRef {
  rootChain: RootChain;
  rootAddress: string;
  zone: string;
  network: Network;
}
