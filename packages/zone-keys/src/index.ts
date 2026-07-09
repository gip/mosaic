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
  type BlobHeader,
  type WrappedBlob,
  type SigKdfInfo,
  type PassKdfInfo,
  type BackupFile,
} from './blob.js';
export { evmAddressFromPublicKey, evmAddressFromPrivateKey, toEip55 } from './address/evm.js';
export { xrplAddressFromPublicKey } from './address/xrpl.js';
export { stellarAddressFromPublicKey, stellarPublicKeyFromAddress } from './address/stellar.js';
