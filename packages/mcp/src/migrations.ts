import { MAX_AGENT_MANIFEST_BYTES, MAX_AGENT_SOURCE_BYTES } from '@mosaic/local-runtime';

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
  `
  ALTER TABLE zones ADD COLUMN last_unlocked_at TIMESTAMPTZ;
  `,
  `
  CREATE TABLE zone_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    chain TEXT NOT NULL CHECK (chain IN ('evm','xrpl','stellar')),
    derivation_index INT NOT NULL CHECK (derivation_index >= 0),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (zone_id, chain, derivation_index),
    UNIQUE (zone_id, chain, name)
  );
  INSERT INTO zone_addresses (zone_id, chain, derivation_index, name)
  SELECT id, chain, 0, '#0' FROM zones CROSS JOIN (VALUES ('evm'), ('xrpl'), ('stellar')) AS chains(chain);
  `,
  `
  ALTER TABLE blobs DROP CONSTRAINT blobs_kind_check;
  ALTER TABLE blobs ADD CONSTRAINT blobs_kind_check CHECK (kind IN ('sig','pass','device'));
  `,
  `
  CREATE TABLE wallet_settings (
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    lock_reminder_minutes INT NOT NULL CHECK (lock_reminder_minutes IN (0,1,3,5,10,30)),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (root_chain, root_address)
  );
  `,
  `
  ALTER TABLE wallet_settings ADD COLUMN hidden_chains TEXT NOT NULL DEFAULT '';
  `,
  `
  ALTER TABLE chain_preferences RENAME COLUMN trusted TO enabled;

  -- Fold the retired "Active" flag (wallet_settings.hidden_chains) into enabled.
  UPDATE chain_preferences cp SET enabled = FALSE
  FROM wallet_settings ws
  WHERE ws.root_chain = cp.root_chain AND ws.root_address = cp.root_address
    AND cp.chain_id = ANY(string_to_array(ws.hidden_chains, ','));

  -- One flag per logical chain: builtin testnet variants take the mainnet value.
  UPDATE chain_preferences cp SET enabled = m.enabled, updated_at = now()
  FROM chain_preferences m
  WHERE m.root_chain = cp.root_chain AND m.root_address = cp.root_address
    AND (cp.chain_id, m.chain_id) IN (('base-sepolia','base-mainnet'),
        ('xrpl-testnet','xrpl-mainnet'),('stellar-testnet','stellar-mainnet'));

  ALTER TABLE wallet_settings DROP COLUMN hidden_chains;

  CREATE TABLE zone_chain_settings (
    zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zone_id, chain_id)
  );
  `,
  `
  ALTER TABLE blobs DROP CONSTRAINT blobs_kind_check;
  ALTER TABLE blobs ADD CONSTRAINT blobs_kind_check CHECK (kind IN ('sig','pass','device','server'));
  `,
  `
  ALTER TABLE blobs DROP CONSTRAINT blobs_kind_check;
  ALTER TABLE blobs ADD CONSTRAINT blobs_kind_check CHECK (kind IN ('sig','pass','device','server','data'));
  `,
  `
  ALTER TABLE blobs DROP CONSTRAINT blobs_kind_check;
  ALTER TABLE blobs ADD CONSTRAINT blobs_kind_check CHECK (kind IN ('sig','pass','device','server','data','agent-secrets'));

  CREATE TABLE agent_artifacts (
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
    package_name TEXT NOT NULL CHECK (length(package_name) <= 64 AND package_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    manifest JSONB NOT NULL CHECK (octet_length(manifest::text) <= ${MAX_AGENT_MANIFEST_BYTES}),
    source BYTEA NOT NULL CHECK (octet_length(source) BETWEEN 1 AND ${MAX_AGENT_SOURCE_BYTES}),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (root_chain, root_address, network, artifact_digest)
  );
  CREATE INDEX agent_artifacts_owner_package_idx
    ON agent_artifacts (root_chain, root_address, network, package_name, created_at);
  `,
  `
  CREATE TABLE agent_artifact_tickets (
    ticket_hash TEXT PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
    runner_certificate_digest TEXT NOT NULL CHECK (runner_certificate_digest ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    max_reads INTEGER NOT NULL CHECK (max_reads BETWEEN 1 AND 3),
    reads INTEGER NOT NULL DEFAULT 0 CHECK (reads >= 0)
  );
  CREATE INDEX agent_artifact_tickets_expiry_idx ON agent_artifact_tickets (expires_at);
  `,
  `
  ALTER TABLE zone_addresses ADD COLUMN address TEXT;
  CREATE UNIQUE INDEX zone_addresses_public_address_idx
    ON zone_addresses (chain, address) WHERE address IS NOT NULL;

  CREATE TABLE dex_orders (
    id UUID PRIMARY KEY,
    cursor BIGSERIAL UNIQUE NOT NULL,
    root_chain TEXT NOT NULL CHECK (root_chain IN ('evm','xrpl','stellar')),
    root_address TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
    chain TEXT NOT NULL CHECK (chain IN ('xrpl','stellar')),
    source_address TEXT NOT NULL,
    status TEXT NOT NULL,
    record JSONB NOT NULL,
    signed_payload TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX dex_orders_owner_cursor_idx
    ON dex_orders (root_chain, root_address, network, cursor DESC);
  CREATE INDEX dex_orders_nonterminal_idx
    ON dex_orders (status, updated_at) WHERE status IN ('submitted','confirmed','open','partially_filled','unknown');
  `,
  `
  CREATE TABLE dex_activity_events (
    cursor BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES dex_orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    record JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX dex_activity_events_order_idx ON dex_activity_events (order_id, cursor DESC);

  ALTER TABLE dex_orders ADD COLUMN activity_cursor BIGINT;
  INSERT INTO dex_activity_events (order_id, status, record, created_at)
    SELECT id, status, record, updated_at FROM dex_orders ORDER BY cursor;
  UPDATE dex_orders orders SET activity_cursor = event.cursor
    FROM dex_activity_events event WHERE event.order_id = orders.id;
  ALTER TABLE dex_orders ALTER COLUMN activity_cursor SET NOT NULL;
  CREATE UNIQUE INDEX dex_orders_activity_cursor_idx ON dex_orders (activity_cursor);
  `,
];
