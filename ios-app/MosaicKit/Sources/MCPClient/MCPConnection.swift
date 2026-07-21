import Foundation
import MosaicCore

/// Minimal MCP client over Streamable HTTP — the native counterpart of the
/// web client's `StreamableHTTPClientTransport` usage in frontend/src/api.ts.
/// Speaks exactly what the server needs: `initialize`, the `initialized`
/// notification, and `tools/call`, with responses arriving either as plain
/// JSON or SSE-framed on the POST response.
public actor MCPConnection {
  private static let protocolVersion = "2025-03-26"

  private let url: URL
  private let session: URLSession
  private var sessionID: String?
  private var nextID = 1

  public init(url: URL) {
    self.url = url
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30
    self.session = URLSession(configuration: config)
  }

  public func callTool(_ name: String, arguments: JSONValue) async throws -> JSONValue {
    try await ensureInitialized()
    let id = nextID
    nextID += 1
    let request: JSONValue = [
      "jsonrpc": "2.0",
      "id": .number(Double(id)),
      "method": "tools/call",
      "params": ["name": .string(name), "arguments": arguments],
    ]
    var response: JSONValue?
    do {
      response = try await post(request, expectingID: id)
    } catch MCPError.transport(let message) where message.contains("HTTP 404") && sessionID != nil {
      // Server evicted the transport session; establish a fresh one and retry once.
      sessionID = nil
      try await ensureInitialized()
      response = try await post(request, expectingID: id)
    }
    guard let response else { throw MCPError.transport("no response for tools/call \(name)") }
    if let error = response["error"] {
      throw MCPError.rpc(
        code: Int(error["code"]?.numberValue ?? 0),
        message: error["message"]?.stringValue ?? "tool \(name) failed"
      )
    }
    let result = response["result"]
    let text = result?["content"]?[0]?["text"]?.stringValue ?? "{}"
    let data = try parseJSON(text)
    if result?["isError"]?.boolValue == true {
      let envelope = data["error"]
      throw MCPError.tool(
        code: envelope?["code"]?.stringValue,
        message: envelope?["message"]?.stringValue ?? "tool \(name) failed"
      )
    }
    return data
  }

  /// Drop the transport session (e.g. after switching servers).
  public func reset() {
    sessionID = nil
  }

  private func ensureInitialized() async throws {
    guard sessionID == nil else { return }
    let id = nextID
    nextID += 1
    let request: JSONValue = [
      "jsonrpc": "2.0",
      "id": .number(Double(id)),
      "method": "initialize",
      "params": [
        "protocolVersion": .string(Self.protocolVersion),
        "capabilities": [:],
        "clientInfo": ["name": "mosaic-ios", "version": "0.1.0"],
      ],
    ]
    let response = try await post(request, expectingID: id)
    if let error = response?["error"] {
      throw MCPError.rpc(
        code: Int(error["code"]?.numberValue ?? 0),
        message: error["message"]?.stringValue ?? "initialize failed"
      )
    }
    guard sessionID != nil else { throw MCPError.transport("server returned no mcp-session-id") }
    let note: JSONValue = ["jsonrpc": "2.0", "method": "notifications/initialized"]
    _ = try await post(note, expectingID: nil)
  }

  /// POST one JSON-RPC message. Returns the matching response for requests,
  /// nil for notifications. Handles both plain-JSON and SSE-framed bodies.
  private func post(_ body: JSONValue, expectingID id: Int?) async throws -> JSONValue? {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
    request.setValue(Self.protocolVersion, forHTTPHeaderField: "mcp-protocol-version")
    if let sessionID { request.setValue(sessionID, forHTTPHeaderField: "mcp-session-id") }
    request.httpBody = try JSONEncoder().encode(body)

    let (bytes, rawResponse) = try await session.bytes(for: request)
    guard let http = rawResponse as? HTTPURLResponse else {
      throw MCPError.transport("non-HTTP response")
    }
    if let returned = http.value(forHTTPHeaderField: "mcp-session-id") {
      sessionID = returned
    }
    guard (200..<300).contains(http.statusCode) else {
      var tail = [UInt8]()
      for try await byte in bytes.prefix(4096) { tail.append(byte) }
      let detail = String(decoding: tail, as: UTF8.self)
      throw MCPError.transport("HTTP \(http.statusCode) from \(url.host ?? "server"): \(detail)")
    }
    guard let id else {
      return nil
    }

    let contentType = http.value(forHTTPHeaderField: "content-type") ?? ""
    if contentType.contains("text/event-stream") {
      // Hand-rolled line splitting: AsyncBytes.lines drops empty lines, and
      // SSE's event delimiter IS the empty line.
      var parser = SSEParser()
      var lineBuffer = [UInt8]()
      for try await byte in bytes {
        if byte == UInt8(ascii: "\n") {
          if lineBuffer.last == UInt8(ascii: "\r") { lineBuffer.removeLast() }
          let line = String(decoding: lineBuffer, as: UTF8.self)
          lineBuffer.removeAll(keepingCapacity: true)
          guard let payload = parser.consume(line: line) else { continue }
          guard let message = try? parseJSON(payload) else { continue }
          if Int(message["id"]?.numberValue ?? -1) == id { return message }
        } else {
          lineBuffer.append(byte)
        }
      }
      throw MCPError.transport("SSE stream ended without a response")
    }
    var raw = Data()
    for try await byte in bytes { raw.append(byte) }
    return try JSONDecoder().decode(JSONValue.self, from: raw)
  }

  private func parseJSON(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }
}
