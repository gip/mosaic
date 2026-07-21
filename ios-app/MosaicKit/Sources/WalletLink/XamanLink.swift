import Foundation
import MCPClient
import MosaicCore

/// Watches a server-created Xaman payload. The MCP server creates every
/// payload (the Xaman API secret is server-only); the phone's job is to open
/// the payload's deeplink in the Xaman app (or show the QR as a fallback) and
/// wait on the payload status WebSocket for the user to sign or reject.
public enum XamanOutcome: Sendable {
  case signed
  case rejected
  case expired
}

public struct XamanLink: Sendable {
  public let refs: XamanRefs

  public init(refs: XamanRefs) {
    self.refs = refs
  }

  /// The deeplink that opens this payload in the Xaman app.
  public var deeplinkURL: URL? { URL(string: refs.deeplink) }

  /// QR fallback for when Xaman is on another device (or the simulator).
  public var qrURL: URL? { URL(string: refs.qrPng) }

  /// Resolves when the payload reaches a terminal state. Xaman's status
  /// socket emits JSON messages; the terminal one carries a boolean `signed`.
  /// An `expires_in_seconds <= 0` message or socket closure ends the wait.
  public func waitForResolution() async throws -> XamanOutcome {
    guard let url = URL(string: refs.websocketStatus) else {
      throw MCPError.transport("invalid Xaman status URL")
    }
    let session = URLSession(configuration: .ephemeral)
    let socket = session.webSocketTask(with: url)
    socket.resume()
    defer {
      socket.cancel(with: .normalClosure, reason: nil)
      session.invalidateAndCancel()
    }
    while true {
      let message = try await socket.receive()
      guard case .string(let text) = message else { continue }
      guard
        let json = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
      else { continue }
      if let signed = json["signed"]?.boolValue {
        return signed ? .signed : .rejected
      }
      if let expired = json["expired"]?.boolValue, expired {
        return .expired
      }
      if let remaining = json["expires_in_seconds"]?.numberValue, remaining <= 0 {
        return .expired
      }
    }
  }
}
