import Foundation
import Security

/// Generic-password Keychain storage. Phase A stores only the MCP session
/// token (`WhenUnlockedThisDeviceOnly`, no biometry — it is a session
/// credential, not custody). Phase B adds the biometry-gated zone-secret
/// items on top of the same primitive.
public struct KeychainItem: Sendable {
  public enum KeychainError: Error {
    case unexpectedStatus(OSStatus)
  }

  public let service: String
  public let account: String

  public init(service: String = "xyz.edfi.mosaic", account: String) {
    self.service = service
    self.account = account
  }

  public func read() throws -> Data? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    return result as? Data
  }

  public func write(_ data: Data) throws {
    let base: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    let attributes: [CFString: Any] = [
      kSecValueData: data,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let update = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else { throw KeychainError.unexpectedStatus(update) }
    let add = base.merging(attributes) { _, new in new }
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
  }

  public func delete() throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unexpectedStatus(status)
    }
  }
}
