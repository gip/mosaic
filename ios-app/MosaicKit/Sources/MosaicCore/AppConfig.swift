import Foundation

/// Runtime configuration. The MCP URL defaults to the local dev server (the
/// iOS simulator reaches the host's loopback directly) and can be overridden
/// in Settings; the override persists in UserDefaults — it is public
/// configuration, never a secret.
public enum AppConfig {
  public static let defaultMCPURL = URL(string: "http://127.0.0.1:8788/mcp")!
  private static let mcpURLKey = "mosaic.mcpURL"

  public static var mcpURL: URL {
    get {
      guard
        let raw = UserDefaults.standard.string(forKey: mcpURLKey),
        let url = URL(string: raw), url.scheme != nil
      else { return defaultMCPURL }
      return url
    }
    set { UserDefaults.standard.set(newValue.absoluteString, forKey: mcpURLKey) }
  }

  public static func resetMCPURL() {
    UserDefaults.standard.removeObject(forKey: mcpURLKey)
  }
}
