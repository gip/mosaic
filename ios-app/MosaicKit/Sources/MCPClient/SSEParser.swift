import Foundation

/// Incremental parser for `text/event-stream` bodies. Feed it decoded lines
/// (without trailing newlines); it emits the `data` payload of each event as
/// the event terminates on a blank line. Only `data:` fields matter for MCP —
/// `event:`/`id:`/retry are accepted and ignored.
public struct SSEParser: Sendable {
  private var dataLines: [String] = []

  public init() {}

  /// Returns the completed event's data, if this line terminated one.
  public mutating func consume(line: String) -> String? {
    if line.isEmpty {
      guard !dataLines.isEmpty else { return nil }
      let data = dataLines.joined(separator: "\n")
      dataLines.removeAll()
      return data
    }
    if line.hasPrefix(":") { return nil }
    guard let colon = line.firstIndex(of: ":") else { return nil }
    let field = line[..<colon]
    guard field == "data" else { return nil }
    var value = line[line.index(after: colon)...]
    if value.hasPrefix(" ") { value = value.dropFirst() }
    dataLines.append(String(value))
    return nil
  }
}
