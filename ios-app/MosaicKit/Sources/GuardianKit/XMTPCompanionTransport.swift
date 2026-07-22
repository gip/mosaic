import Foundation
import MosaicCore
import VaultKeychain
import XMTPiOS

/// XMTP transport for the companion (ADR 0002). The transport identity is a
/// phone-generated secp256k1 key + database key persisted in the Keychain
/// with `AfterFirstUnlockThisDeviceOnly` and NO biometry — receiving while
/// the vault is locked is the whole point; the identity signs nothing but
/// XMTP registration and is never an approval authority.
public final class XMTPCompanionTransport: CompanionTransport, @unchecked Sendable {
  public enum TransportError: Error, LocalizedError {
    case identity

    public var errorDescription: String? { "could not create the XMTP transport identity" }
  }

  private let client: Client
  public let inboxId: String

  private init(client: Client) {
    self.client = client
    self.inboxId = client.inboxID
  }

  /// Create (or restore) the transport for a network. Identity and DB key are
  /// per-network Keychain items; the local XMTP database lives in the app
  /// support directory.
  public static func create(network: Network) async throws -> XMTPCompanionTransport {
    let identityItem = KeychainItem(service: "xyz.edfi.mosaic.xmtp", account: "identity-\(network.rawValue)")
    let dbKeyItem = KeychainItem(service: "xyz.edfi.mosaic.xmtp", account: "dbkey-\(network.rawValue)")

    let signingKey: PrivateKey
    if let stored = try identityItem.read(), stored.count == 32 {
      signingKey = try PrivateKey(stored)
    } else {
      let fresh = try PrivateKey.generate()
      try identityItem.write(fresh.secp256K1.bytes)
      signingKey = fresh
    }
    let dbKey: Data
    if let stored = try dbKeyItem.read(), stored.count == 32 {
      dbKey = stored
    } else {
      var bytes = [UInt8](repeating: 0, count: 32)
      _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
      dbKey = Data(bytes)
      try dbKeyItem.write(dbKey)
    }

    let directory = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appending(path: "xmtp", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    // Desktop mapping (packages/local-runtime/src/xmtpControl.ts): testnet →
    // dev network, mainnet → production.
    let env: XMTPEnvironment = network == .testnet ? .dev : .production
    let options = ClientOptions(
      api: .init(env: env, isSecure: true),
      dbEncryptionKey: dbKey,
      dbDirectory: directory.path
    )
    let client = try await Client.create(account: signingKey, options: options)
    return XMTPCompanionTransport(client: client)
  }

  public func send(to inboxId: String, content: String) async throws {
    let conversation = try await client.conversations.findOrCreateDm(with: inboxId)
    _ = try await conversation.send(content: content)
  }

  public func messages() -> AsyncStream<CompanionMessage> {
    AsyncStream { continuation in
      let task = Task {
        do {
          for try await message in await self.client.conversations.streamAllMessages() {
            guard message.senderInboxId != self.inboxId else { continue }
            guard let text = try? message.content() as String else { continue }
            continuation.yield(
              CompanionMessage(id: message.id, senderInboxId: message.senderInboxId, content: text)
            )
          }
        } catch {
          // Stream ended (network drop / app background); callers restart.
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  public func close() async {
    // Client owns no long-lived resources beyond the stream tasks.
  }
}
