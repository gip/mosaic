/**
 * Ordered SQL migrations. Append-only: never edit an entry that has shipped —
 * add a new one. Applied inside per-migration transactions by PostgresStore.init().
 */
export const MIGRATIONS: string[] = [
  `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    zone TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    commitment TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    local_signer_public_key TEXT NOT NULL,
    authorize_message JSONB NOT NULL,
    authorize_signature JSONB NOT NULL,
    xrpl_signin_template JSONB,
    layer1_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (root_chain, root_address, zone, network)
  );

  CREATE TABLE blobs (
    zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('sig','pass')),
    version INT NOT NULL,
    ciphertext BYTEA NOT NULL,
    header JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zone_id, kind, version)
  );

  CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('session-auth','authorize-zone')),
    chain TEXT NOT NULL CHECK (chain IN ('evm','xrpl','stellar')),
    address TEXT,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    message JSONB NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    xaman_payload_uuid TEXT,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    chain TEXT NOT NULL CHECK (chain IN ('evm','xrpl','stellar')),
    address TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
  `,
  `
  CREATE TABLE custom_chains (
    id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    family TEXT NOT NULL DEFAULT 'evm' CHECK (family = 'evm'),
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    evm_chain_id BIGINT NOT NULL UNIQUE CHECK (evm_chain_id > 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE chain_preferences (
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    trusted BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (root_chain, root_address, chain_id)
  );

  CREATE TABLE asset_preferences (
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    trust_state TEXT NOT NULL CHECK (trust_state IN ('hidden','review','allowed')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (root_chain, root_address, asset_id)
  );

  CREATE INDEX chain_preferences_owner_idx ON chain_preferences (root_chain, root_address);
  CREATE INDEX asset_preferences_owner_idx ON asset_preferences (root_chain, root_address);
  `,
];
