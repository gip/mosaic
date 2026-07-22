import Foundation
import LocalAuthentication
import MCPClient
import MosaicCore
import Observation
import VaultKeychain
import ZoneCryptoJS

/// Zone unlock state and key custody on the phone. Mirrors the web unlock
/// semantics (frontend/src/zone/unlock.ts): cache hit → Face ID; cache miss →
/// one backup-wrap re-signature (layer 1) or the passphrase (layer 2). The
/// unwrapped secret lives only in the biometry-gated Keychain; every signing
/// operation re-reads it behind Face ID and hands it to the networkless JS
/// context for the single call.
@Observable @MainActor
final class VaultStore {
  struct UnlockedZone {
    let ref: ZoneRef
    let commitment: String
    /// Zone address entries with derived addresses filled in.
    let addresses: [ZoneAddressItem]
  }

  enum VaultError: Error, LocalizedError {
    case missingBlob(String)
    case biometryUnavailable
    case xamanUnavailable
    case notUnlocked

    var errorDescription: String? {
      switch self {
      case .missingBlob(let kind): return "This zone has no '\(kind)' recovery blob."
      case .biometryUnavailable: return "Face ID is unavailable; unlock with your wallet or passphrase."
      case .xamanUnavailable: return "Xaman re-signing is only available for XRPL root wallets."
      case .notUnlocked: return "Unlock the zone before signing."
      }
    }
  }

  let engine = ZoneCryptoEngine()
  private let secrets = ZoneSecretStore()
  private(set) var unlocked: [String: UnlockedZone] = [:]

  func isUnlocked(zoneId: String) -> Bool {
    unlocked[zoneId] != nil
  }

  func ref(for zone: ZoneListItem, auth: AuthVerifyResult) -> ZoneRef {
    ZoneRef(rootChain: auth.chain, rootAddress: auth.address, zone: zone.zone, network: auth.network)
  }

  func hasCachedSecret(ref: ZoneRef) -> Bool {
    secrets.exists(cacheKey: ref.cacheKey)
  }

  // MARK: Unlock paths

  /// Cache hit: Face ID → commitment check → derive. Returns false when no
  /// cached secret exists (callers fall through to layer 1 / 2).
  func unlockFromCache(zone: ZoneListItem, auth: AuthVerifyResult, api: MosaicAPI) async throws -> Bool {
    let ref = ref(for: zone, auth: auth)
    let context = LAContext()
    guard
      let data = secrets.read(
        cacheKey: ref.cacheKey,
        context: context,
        reason: "Unlock zone \(zone.zone)"
      )
    else { return false }
    let secretHex = data.map { String(format: "%02x", $0) }.joined()
    guard try await engine.verifyCommitment(secretHex: secretHex, commitment: zone.commitment) else {
      // Stale cache (zone was re-created) — drop it and fall through.
      try? secrets.delete(cacheKey: ref.cacheKey)
      return false
    }
    try await finishUnlock(zone: zone, ref: ref, secretHex: secretHex, auth: auth, api: api)
    return true
  }

  /// Layer 1 for XRPL roots: the caller has already run the Xaman backup-wrap
  /// payload round-trip and holds the signed blob hex.
  func unlockWithXamanBlob(
    zone: ZoneListItem, auth: AuthVerifyResult, api: MosaicAPI, signedBlobHex: String
  ) async throws {
    let ref = ref(for: zone, auth: auth)
    let blob = try await api.blobGet(token: auth.token, zone: zone.zone, kind: "sig")
    let signatureHex = try await engine.xrplTxnSignatureBytes(blobHex: signedBlobHex)
    let secretHex = try await engine.openSignatureBlob(
      signatureHex: signatureHex,
      headerJson: blob.headerJson,
      ciphertextB64: blob.ciphertextB64,
      ref: ref,
      commitment: zone.commitment
    )
    cacheSecret(secretHex: secretHex, ref: ref)
    try await finishUnlock(zone: zone, ref: ref, secretHex: secretHex, auth: auth, api: api)
  }

  /// Layer 1 for EVM/Stellar roots: the caller signed the byte-identical
  /// backup-wrap message via WalletConnect and holds the raw signature bytes.
  func unlockWithSignatureBytes(
    zone: ZoneListItem, auth: AuthVerifyResult, api: MosaicAPI, signatureHex: String
  ) async throws {
    let ref = ref(for: zone, auth: auth)
    let blob = try await api.blobGet(token: auth.token, zone: zone.zone, kind: "sig")
    let secretHex = try await engine.openSignatureBlob(
      signatureHex: signatureHex,
      headerJson: blob.headerJson,
      ciphertextB64: blob.ciphertextB64,
      ref: ref,
      commitment: zone.commitment
    )
    cacheSecret(secretHex: secretHex, ref: ref)
    try await finishUnlock(zone: zone, ref: ref, secretHex: secretHex, auth: auth, api: api)
  }

  /// Layer 2: passphrase → Argon2id (off-main; 256 MiB) → open.
  func unlockWithPassphrase(
    zone: ZoneListItem, auth: AuthVerifyResult, api: MosaicAPI, passphrase: String
  ) async throws {
    let ref = ref(for: zone, auth: auth)
    let blob = try await api.blobGet(token: auth.token, zone: zone.zone, kind: "pass")
    let params = try await engine.passphraseKdfParams(headerJson: blob.headerJson, ciphertextB64: blob.ciphertextB64)
    guard let salt = Data(hexString: params.saltHex) else { throw VaultError.missingBlob("pass") }
    let kek = try await Task.detached(priority: .userInitiated) {
      try Argon2.deriveKek(passphrase: passphrase, salt: Array(salt), m: params.m, t: params.t, p: params.p)
    }.value
    let secretHex = try await engine.openPassphraseBlob(
      kekHex: kek.map { String(format: "%02x", $0) }.joined(),
      headerJson: blob.headerJson,
      ciphertextB64: blob.ciphertextB64,
      ref: ref,
      commitment: zone.commitment
    )
    cacheSecret(secretHex: secretHex, ref: ref)
    try await finishUnlock(zone: zone, ref: ref, secretHex: secretHex, auth: auth, api: api)
  }

  private func cacheSecret(secretHex: String, ref: ZoneRef) {
    guard let data = Data(hexString: secretHex) else { return }
    // Best effort: on devices without enrolled biometry the ACL add fails and
    // the zone simply needs a re-unlock next session.
    try? secrets.write(secret: data, cacheKey: ref.cacheKey)
  }

  private func finishUnlock(
    zone: ZoneListItem, ref: ZoneRef, secretHex: String, auth: AuthVerifyResult, api: MosaicAPI
  ) async throws {
    var byIndex: [Int: ZoneCryptoEngine.AgentAddresses] = [:]
    var derived: [ZoneAddressItem] = []
    for entry in zone.addresses {
      let addresses: ZoneCryptoEngine.AgentAddresses
      if let cached = byIndex[entry.index] {
        addresses = cached
      } else {
        addresses = try await engine.deriveAddresses(secretHex: secretHex, ref: ref, index: entry.index)
        byIndex[entry.index] = addresses
      }
      derived.append(
        ZoneAddressItem(
          id: entry.id,
          zoneId: entry.zoneId,
          chain: entry.chain,
          index: entry.index,
          name: entry.name,
          address: addresses.address(for: entry.chain),
          createdAt: entry.createdAt
        )
      )
    }
    unlocked[zone.zoneId] = UnlockedZone(ref: ref, commitment: zone.commitment, addresses: derived)
    try? await api.zoneUnlocked(
      token: auth.token,
      zone: zone.zone,
      addresses: derived.compactMap { entry in entry.address.map { (id: entry.id, address: $0) } }
    )
  }

  // MARK: Signing (Face ID per operation)

  /// Read the cached secret behind Face ID and run one signing closure.
  func withSecret<T: Sendable>(
    ref: ZoneRef, reason: String, _ body: @Sendable (String) async throws -> T
  ) async throws -> T {
    let context = LAContext()
    guard let data = secrets.read(cacheKey: ref.cacheKey, context: context, reason: reason) else {
      throw VaultError.notUnlocked
    }
    let secretHex = data.map { String(format: "%02x", $0) }.joined()
    return try await body(secretHex)
  }

  // MARK: Lock / forget

  /// Drop in-memory unlock state; the Keychain cache stays for Face ID re-unlock.
  func lock(zoneId: String) {
    unlocked.removeValue(forKey: zoneId)
    Task { await engine.invalidate() }
  }

  /// Also forget the cached secret — next unlock needs the wallet or passphrase.
  func forget(zone: ZoneListItem, auth: AuthVerifyResult) {
    let ref = ref(for: zone, auth: auth)
    try? secrets.delete(cacheKey: ref.cacheKey)
    lock(zoneId: zone.zoneId)
  }

  /// Drop all in-memory unlock state (logout/expiry); biometry-gated caches
  /// stay for the next session, matching the web's IndexedDB behavior.
  func lockAll() {
    unlocked.removeAll()
    Task { await engine.invalidate() }
  }

  func wipeAll() {
    unlocked.removeAll()
    try? secrets.deleteAll()
    Task { await engine.invalidate() }
  }
}

extension Data {
  init?(hexString: String) {
    let clean = hexString.hasPrefix("0x") ? String(hexString.dropFirst(2)) : hexString
    guard clean.count % 2 == 0 else { return nil }
    var bytes = [UInt8]()
    var index = clean.startIndex
    while index < clean.endIndex {
      let next = clean.index(index, offsetBy: 2)
      guard let byte = UInt8(clean[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}
