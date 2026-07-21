import Foundation

public enum MCPError: Error, LocalizedError, Sendable {
  /// Transport or protocol failure (HTTP status, malformed frame, lost session).
  case transport(String)
  /// JSON-RPC level error returned by the server.
  case rpc(code: Int, message: String)
  /// Tool completed with `isError` — carries the server's error envelope.
  case tool(code: String?, message: String)

  public var errorDescription: String? {
    switch self {
    case .transport(let message): return message
    case .rpc(_, let message): return message
    case .tool(_, let message): return message
    }
  }

  public var toolCode: String? {
    if case .tool(let code, _) = self { return code }
    return nil
  }
}
