import Foundation
import LocalAuthentication
import Security

/// Biometry-gated Keychain cache for unlocked zone secrets. The wrapped blob
/// on the backend stays the source of truth — losing this cache costs one
/// wallet re-signature. Items are `biometryCurrentSet` (re-enrolling Face ID
/// invalidates them) and `WhenUnlockedThisDeviceOnly` (never in backups).
public struct ZoneSecretStore: Sendable {
  public enum StoreError: Error, LocalizedError {
    case unexpectedStatus(OSStatus)
    case accessControl

    public var errorDescription: String? {
      switch self {
      case .unexpectedStatus(let status): return "Keychain error \(status)"
      case .accessControl: return "could not build Keychain access control"
      }
    }
  }

  private let service: String

  public init(service: String = "xyz.edfi.mosaic.zone-secret") {
    self.service = service
  }

  private func accessControl() throws -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard
      let control = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .biometryCurrentSet,
        &error
      )
    else { throw StoreError.accessControl }
    return control
  }

  /// Store (replace) the secret for a zone cache key.
  public func write(secret: Data, cacheKey: String) throws {
    try? delete(cacheKey: cacheKey)
    let attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: cacheKey,
      kSecValueData: secret,
      kSecAttrAccessControl: try accessControl(),
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw StoreError.unexpectedStatus(status) }
  }

  /// Read the secret; triggers the Face ID prompt via `context`. Returns nil
  /// when absent or when biometry was cancelled/invalidated.
  public func read(cacheKey: String, context: LAContext, reason: String) -> Data? {
    context.localizedReason = reason
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: cacheKey,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecUseAuthenticationContext: context,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return nil }
    return result as? Data
  }

  public func exists(cacheKey: String) -> Bool {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: cacheKey,
      kSecUseAuthenticationUI: kSecUseAuthenticationUISkip,
    ]
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  public func delete(cacheKey: String) throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: cacheKey,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw StoreError.unexpectedStatus(status)
    }
  }

  /// Wipe every cached zone secret (Settings → lock/wipe, logout).
  public func deleteAll() throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw StoreError.unexpectedStatus(status)
    }
  }
}
