export { ZONE_PROTOCOL } from './messages.js';

export type { RootChain, AgentChain, Network, ZoneRef } from './types.js';
export { canonicalJson, canonicalBytes, type CanonicalScalar } from './canonical.js';
export {
  ZONE_ROOT_SECRET_LENGTH,
  zoneRootCommitment,
  zoneRootCommitmentHex,
  verifyCommitment,
} from './commitment.js';
export { ZONE_DOMAIN_V1, ZONE_SEED_LENGTH, zoneSeed } from './zoneSeed.js';
export {
  slip10MasterFromSeed,
  slip10DeriveHardened,
  slip10DerivePath,
  type Slip10Node,
} from './slip10.js';
export {
  deriveEvmAgentKey,
  deriveXrplAgentKey,
  deriveStellarAgentKey,
  deriveAgentAddresses,
  type AgentKey,
  type AgentAddresses,
} from './derive.js';
export {
  backupWrapMessage,
  authorizeZoneMessage,
  sessionAuthMessage,
  eip712Domain,
  eip712TypedData,
  eip712PrimaryType,
  EIP712_TYPES,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  SESSION_AUDIENCE,
  SEP53_PREFIX,
  XRPL_MEMO_TYPE,
  EVM_CHAIN_IDS,
  type AuthorizeZoneMessage,
  type BackupWrapMessage,
  type SessionAuthMessage,
  type ZoneMessage,
  type Eip712PrimaryType,
} from './messages.js';
export {
  BACKUP_DOMAIN_V1,
  ARGON2_PARAMS_V1,
  BLOB_NONCE_LENGTH,
  backupSignaturesDeterministic,
  wrapKeyFromSignature,
  sealSignatureBlob,
  openSignatureBlob,
  sealPassphraseBlob,
  openPassphraseBlob,
  passphraseKdfParams,
  encodeBackupFile,
  decodeBackupBlob,
  decodeVaultDataBackupBlob,
  type BlobHeader,
  type WrappedBlob,
  type SigKdfInfo,
  type PassKdfInfo,
  type BackupFile,
} from './blob.js';
export { evmAddressFromPublicKey, evmAddressFromPrivateKey, toEip55 } from './address/evm.js';
export { xrplAddressFromPublicKey } from './address/xrpl.js';
export { stellarAddressFromPublicKey, stellarPublicKeyFromAddress } from './address/stellar.js';
export {
  VAULT_DATA_DOMAIN_V1,
  VAULT_DATA_MAX_PLAINTEXT_BYTES,
  VAULT_DATA_NONCE_LENGTH,
  vaultDataKey,
  sealVaultData,
  openVaultData,
  type VaultIdentityV1,
  type VaultDataV1,
  type VaultDataBlobHeader,
  type WrappedVaultData,
} from './vaultData.js';
export {
  AGENT_SECRET_STORE_DOMAIN_V1,
  AGENT_SECRET_STORE_MAX_PLAINTEXT_BYTES,
  AGENT_SECRET_STORE_NONCE_LENGTH,
  agentSecretStoreKey,
  sealAgentSecretStore,
  openAgentSecretStore,
  type AgentSecretCustody,
  type AgentSecretPurpose,
  type AgentSecretRecordV1,
  type AgentSecretStoreV1,
  type AgentSecretStoreHeaderV1,
  type WrappedAgentSecretStore,
} from './agentSecrets.js';
