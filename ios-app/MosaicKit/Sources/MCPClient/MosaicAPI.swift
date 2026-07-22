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

  public func zoneUnlocked(token: String, zone: String, addresses: [(id: String, address: String)]) async throws {
    let entries = addresses.map { entry -> JSONValue in
      ["id": .string(entry.id), "address": .string(entry.address)]
    }
    _ = try await connection.callTool(
      "zone_unlocked",
      arguments: ["token": .string(token), "zone": .string(zone), "addresses": .array(entries)]
    )
  }

  // MARK: Blobs (unlock)

  public func blobGet(token: String, zone: String, kind: String) async throws -> BlobGetResult {
    let result = try await connection.callTool(
      "blob_get",
      arguments: ["token": .string(token), "zone": .string(zone), "kind": .string(kind)]
    )
    guard
      let header = result["header"],
      let headerData = try? JSONEncoder().encode(header),
      let ciphertext = result["ciphertextB64"]?.stringValue,
      let commitment = result["commitment"]?.stringValue
    else { throw MCPError.transport("malformed blob_get result") }
    return BlobGetResult(
      kind: result["kind"]?.stringValue ?? kind,
      version: Int(result["version"]?.numberValue ?? 0),
      headerJson: String(decoding: headerData, as: UTF8.self),
      ciphertextB64: ciphertext,
      commitment: commitment
    )
  }

  // MARK: Catalog

  public func catalogAssets(token: String) async throws -> [CatalogAsset] {
    let result = try await connection.callTool("catalog_list", arguments: ["token": .string(token)])
    guard let assets = result["assets"] else { return [] }
    return try assets.decoded([CatalogAsset].self)
  }

  // MARK: Transfers

  public func transferPrepare(
    token: String,
    chain: AgentChain,
    source: (kind: String, address: String, zone: String?, addressId: String?, name: String?),
    destination: String,
    assetId: String,
    amount: String
  ) async throws -> TransferPrepared {
    var sourceJson: [String: JSONValue] = ["kind": .string(source.kind), "address": .string(source.address)]
    if let zone = source.zone { sourceJson["zone"] = .string(zone) }
    if let addressId = source.addressId { sourceJson["addressId"] = .string(addressId) }
    if let name = source.name { sourceJson["name"] = .string(name) }
    let result = try await connection.callTool(
      "transfer_prepare",
      arguments: [
        "token": .string(token),
        "chain": .string(chain.rawValue),
        "source": .object(sourceJson),
        "destination": .string(destination),
        "assetId": .string(assetId),
        "amount": .string(amount),
      ]
    )
    guard
      let transferJson = result["transfer"],
      let requestJson = result["signingRequest"],
      let request = SigningRequest(json: requestJson)
    else { throw MCPError.transport("malformed transfer_prepare result") }
    return TransferPrepared(transfer: ActivityItem(json: transferJson), signingRequest: request)
  }

  public enum TransferSigned: Sendable {
    case xrpl(txBlob: String)
    case stellar(signedXdr: String)
    case xaman(payloadUuid: String)
    case evmRaw(serializedTransaction: String)

    var json: JSONValue {
      switch self {
      case .xrpl(let txBlob): return ["kind": "xrpl", "txBlob": .string(txBlob)]
      case .stellar(let signedXdr): return ["kind": "stellar", "signedXdr": .string(signedXdr)]
      case .xaman(let payloadUuid): return ["kind": "xaman", "payloadUuid": .string(payloadUuid)]
      case .evmRaw(let serialized): return ["kind": "evm-raw", "serializedTransaction": .string(serialized)]
      }
    }
  }

  public func transferSubmit(token: String, transferId: String, signed: TransferSigned) async throws -> ActivityItem {
    let result = try await connection.callTool(
      "transfer_submit",
      arguments: ["token": .string(token), "transferId": .string(transferId), "signed": signed.json]
    )
    guard let transfer = result["transfer"] else { throw MCPError.transport("malformed transfer_submit result") }
    return ActivityItem(json: transfer)
  }

  // MARK: Companion devices (push)

  public func deviceRegister(
    token: String, apnsToken: String, deviceName: String, apnsEnvironment: String
  ) async throws {
    _ = try await connection.callTool(
      "device_register",
      arguments: [
        "token": .string(token),
        "apnsToken": .string(apnsToken),
        "deviceName": .string(deviceName),
        "apnsEnvironment": .string(apnsEnvironment),
      ]
    )
  }

  // MARK: Xaman payloads (always server-created; the phone only opens them)

  public func xamanSignCreate(token: String, purpose: String, zone: String) async throws -> XamanRefs {
    let result = try await connection.callTool(
      "xaman_sign_create",
      arguments: ["token": .string(token), "purpose": .string(purpose), "zone": .string(zone)]
    )
    return try result.decoded(XamanRefs.self)
  }

  public func xamanPayloadResult(
    token: String, uuid: String
  ) async throws -> (signed: Bool, resolved: Bool, hex: String?) {
    let result = try await connection.callTool(
      "xaman_payload_result",
      arguments: ["token": .string(token), "uuid": .string(uuid)]
    )
    return (
      result["signed"]?.boolValue ?? false,
      result["resolved"]?.boolValue ?? false,
      result["hex"]?.stringValue
    )
  }
}
