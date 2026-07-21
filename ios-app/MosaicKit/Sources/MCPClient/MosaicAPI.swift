import Foundation
import MosaicCore

/// Typed wrappers over the MCP tool surface, mirroring frontend/src/api.ts.
/// The bearer `token` travels as a tool argument on every authenticated call,
/// exactly as the web client does. Phase A exposes the read/auth surface;
/// unlock and transfer tools arrive with Phase B.
public actor MosaicAPI {
  private var connection: MCPConnection
  private var currentURL: URL

  public init(url: URL) {
    self.currentURL = url
    self.connection = MCPConnection(url: url)
  }

  /// Point at a different MCP server (Settings). Drops the transport session.
  public func setServer(url: URL) {
    guard url != currentURL else { return }
    currentURL = url
    connection = MCPConnection(url: url)
  }

  public var serverURL: URL { currentURL }

  private func call<T: Decodable>(_ name: String, _ args: JSONValue, as type: T.Type) async throws -> T {
    let result = try await connection.callTool(name, arguments: args)
    return try result.decoded(type)
  }

  // MARK: Auth

  public func authChallenge(chain: RootChain, network: Network, address: String? = nil) async throws -> AuthChallengeResult {
    var args: [String: JSONValue] = ["chain": .string(chain.rawValue), "network": .string(network.rawValue)]
    if let address { args["address"] = .string(address) }
    return try await call("auth_challenge", .object(args), as: AuthChallengeResult.self)
  }

  public func authVerify(challengeId: String, signature: SignatureEnvelope?) async throws -> AuthVerifyResult {
    var args: [String: JSONValue] = ["challengeId": .string(challengeId)]
    if let signature { args["signature"] = signature.json }
    return try await call("auth_verify", .object(args), as: AuthVerifyResult.self)
  }

  public func authLogout(token: String) async throws {
    _ = try await connection.callTool("auth_logout", arguments: ["token": .string(token)])
  }

  public func authNetworkSwitch(token: String, network: Network) async throws -> AuthVerifyResult {
    try await call(
      "auth_network_switch",
      ["token": .string(token), "network": .string(network.rawValue)],
      as: AuthVerifyResult.self
    )
  }

  // MARK: Zones

  public func zoneList(token: String) async throws -> [ZoneListItem] {
    try await call("zone_list", ["token": .string(token)], as: [ZoneListItem].self)
  }

  public func zoneGet(token: String, zone: String) async throws -> ZoneGetResult {
    try await call("zone_get", ["token": .string(token), "zone": .string(zone)], as: ZoneGetResult.self)
  }

  // MARK: Activity

  public func activityList(
    token: String,
    limit: Int = 50,
    sourceAddress: String? = nil
  ) async throws -> [ActivityItem] {
    var args: [String: JSONValue] = ["token": .string(token), "limit": .number(Double(limit))]
    if let sourceAddress { args["sourceAddress"] = .string(sourceAddress) }
    let result = try await connection.callTool("activity_list", arguments: .object(args))
    let rows = result["activities"]?.arrayValue ?? []
    return rows.map(ActivityItem.init(json:))
  }

  // MARK: Settings

  public func settingsGet(token: String) async throws -> WalletSettingsResult {
    try await call("settings_get", ["token": .string(token)], as: WalletSettingsResult.self)
  }

  // MARK: Xaman payloads (login is server-created; the phone only opens them)

  public func xamanPayloadResult(token: String, uuid: String) async throws -> (signed: Bool, resolved: Bool) {
    let result = try await connection.callTool(
      "xaman_payload_result",
      arguments: ["token": .string(token), "uuid": .string(uuid)]
    )
    return (result["signed"]?.boolValue ?? false, result["resolved"]?.boolValue ?? false)
  }
}
