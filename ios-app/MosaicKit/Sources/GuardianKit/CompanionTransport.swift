import Foundation

public struct CompanionMessage: Sendable {
  public let id: String
  public let senderInboxId: String
  public let content: String

  public init(id: String, senderInboxId: String, content: String) {
    self.id = id
    self.senderInboxId = senderInboxId
    self.content = content
  }
}

/// The companion's messaging transport (XMTP in production; loopback in
/// tests). Mirrors the desktop's ControlTransport shape.
public protocol CompanionTransport: Sendable {
  var inboxId: String { get }
  func send(to inboxId: String, content: String) async throws
  func messages() -> AsyncStream<CompanionMessage>
  func close() async
}

/// In-memory transport for unit tests and previews.
public final class LoopbackCompanionTransport: CompanionTransport, @unchecked Sendable {
  public let inboxId: String
  private var continuation: AsyncStream<CompanionMessage>.Continuation?
  private let lock = NSLock()
  private var nextId = 0
  /// Messages this transport sent, for assertions.
  public private(set) var outbox: [(inboxId: String, content: String)] = []

  public init(inboxId: String) {
    self.inboxId = inboxId
  }

  public func send(to inboxId: String, content: String) async throws {
    lock.lock()
    outbox.append((inboxId, content))
    lock.unlock()
  }

  public func messages() -> AsyncStream<CompanionMessage> {
    AsyncStream { continuation in
      self.lock.lock()
      self.continuation = continuation
      self.lock.unlock()
    }
  }

  /// Test hook: deliver an inbound message.
  public func deliver(from senderInboxId: String, content: String) {
    lock.lock()
    nextId += 1
    let message = CompanionMessage(id: "loopback-\(nextId)", senderInboxId: senderInboxId, content: content)
    let continuation = self.continuation
    lock.unlock()
    continuation?.yield(message)
  }

  public func close() async {
    lock.lock()
    continuation?.finish()
    continuation = nil
    lock.unlock()
  }
}
