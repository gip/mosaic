import Foundation

// Mirrors of the MCP tool result shapes consumed by the web client
// (frontend/src/api.ts) and the shared literal vocabulary from
// @mosaic/zone-keys and @mosaic/chain-core. Decimal amounts stay `String`
// end to end — never Double.

public enum RootChain: String, Codable, CaseIterable, Sendable, Identifiable {
  case evm, xrpl, stellar
  public var id: String { rawValue }

  public var displayName: String {
    switch self {
    case .evm: return "EVM (Base)"
    case .xrpl: return "XRPL"
    case .stellar: return "Stellar"
    }
  }
}

public typealias AgentChain = RootChain

public enum Network: String, Codable, CaseIterable, Sendable, Identifiable {
  case mainnet, testnet
  public var id: String { rawValue }
}

/// The frozen zone reference tuple from @mosaic/zone-keys — binds every
/// derivation and blob operation to (root wallet, zone, network).
public struct ZoneRef: Codable, Sendable, Equatable, Hashable {
  public let rootChain: RootChain
  public let rootAddress: String
  public let zone: String
  public let network: Network

  public init(rootChain: RootChain, rootAddress: String, zone: String, network: Network) {
    self.rootChain = rootChain
    self.rootAddress = rootAddress
    self.zone = zone
    self.network = network
  }

  /// Stable JSON for the JS bridge (key order is irrelevant there — the
  /// bridge re-parses into an object before any canonicalization).
  public var jsonString: String {
    let fields = [
      "rootChain": rootChain.rawValue,
      "rootAddress": rootAddress,
      "zone": zone,
      "network": network.rawValue,
    ]
    let data = try! JSONSerialization.data(withJSONObject: fields)
    return String(decoding: data, as: UTF8.self)
  }

  /// Cache key used across Keychain items — same scheme as the web cache.
  public var cacheKey: String {
    "\(rootChain.rawValue)|\(rootAddress)|\(zone)|\(network.rawValue)"
  }
}

public struct XamanRefs: Codable, Sendable, Equatable {
  public let uuid: String
  public let qrPng: String
  public let websocketStatus: String
  public let deeplink: String
}

public struct AuthChallengeResult: Codable, Sendable {
  public let challengeId: String
  /// Canonical session-auth message — opaque to the phone; passed to the
  /// wallet for signing exactly as received.
  public let message: JSONValue
  public let expiresAt: String
  public let evmChainId: Int?
  public let xaman: XamanRefs?
}

public enum SignatureEnvelope: Sendable {
  case evm(signature: String)
  case stellar(signatureB64: String)
  case xrpl(payloadUuid: String)

  public var json: JSONValue {
    switch self {
    case .evm(let signature): return ["type": "evm", "signature": .string(signature)]
    case .stellar(let signatureB64): return ["type": "stellar", "signatureB64": .string(signatureB64)]
    case .xrpl(let payloadUuid): return ["type": "xrpl", "payloadUuid": .string(payloadUuid)]
    }
  }
}

public struct AuthVerifyResult: Codable, Sendable, Equatable {
  public let token: String
  public let chain: RootChain
  public let address: String
  public let network: Network
  /// Milliseconds since epoch, as the server reports it.
  public let expiresAt: Double

  public init(token: String, chain: RootChain, address: String, network: Network, expiresAt: Double) {
    self.token = token
    self.chain = chain
    self.address = address
    self.network = network
    self.expiresAt = expiresAt
  }
}

public struct ZoneChainSetting: Codable, Sendable, Equatable, Identifiable {
  public let chainId: String
  public let chainKey: String
  public let name: String
  public let family: String
  public let network: String
  public let evmChainId: Int?
  public let enabled: Bool
  public var id: String { chainId }
}

public struct ZoneAddressItem: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let zoneId: String
  public let chain: AgentChain
  public let index: Int
  public let name: String
  public let address: String?
  public let createdAt: String

  public init(id: String, zoneId: String, chain: AgentChain, index: Int, name: String, address: String?, createdAt: String) {
    self.id = id
    self.zoneId = zoneId
    self.chain = chain
    self.index = index
    self.name = name
    self.address = address
    self.createdAt = createdAt
  }
}

public enum ZoneMode: String, Codable, Sendable {
  case signed
  case testnetDevice = "testnet-device"
  case testnetServer = "testnet-server"
}

public struct ZoneListItem: Codable, Sendable, Equatable, Identifiable {
  public let zoneId: String
  public let zone: String
  public let commitment: String
  public let mode: ZoneMode
  public let createdAt: String
  public let lastUnlockedAt: String?
  public let addresses: [ZoneAddressItem]
  public let chains: [ZoneChainSetting]
  public var id: String { zoneId }
}

public struct ZoneBlobRef: Codable, Sendable, Equatable {
  public let kind: String
  public let version: Int
}

public struct ZoneGetResult: Codable, Sendable {
  public let exists: Bool
  public let zoneId: String?
  public let commitment: String?
  public let policyHash: String?
  public let layer1Enabled: Bool?
  public let createdAt: String?
  public let lastUnlockedAt: String?
  public let blobs: [ZoneBlobRef]?
  public let chains: [ZoneChainSetting]?
}

public struct WalletSettingsResult: Codable, Sendable, Equatable {
  public let lockReminderMinutes: Int
  public let chainSetupCompleted: Bool
}

public struct BlobGetResult: Sendable {
  public let kind: String
  public let version: Int
  /// Raw header JSON, passed to the crypto bridge verbatim.
  public let headerJson: String
  public let ciphertextB64: String
  public let commitment: String

  public init(kind: String, version: Int, headerJson: String, ciphertextB64: String, commitment: String) {
    self.kind = kind
    self.version = version
    self.headerJson = headerJson
    self.ciphertextB64 = ciphertextB64
    self.commitment = commitment
  }
}

public struct CatalogAssetDeployment: Codable, Sendable, Equatable {
  public let chainId: String
  public let symbol: String
  public let kind: String
  public let decimals: Int
  public let address: String?
  public let currencyCode: String?
}

public struct CatalogAsset: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let deployments: [CatalogAssetDeployment]
  public let trustState: String

  public func deployment(chainId: String) -> CatalogAssetDeployment? {
    deployments.first { $0.chainId == chainId }
  }
}

/// The per-chain signing request returned by `transfer_prepare`.
public enum SigningRequest: Sendable {
  case xrpl(unsignedTransactionJson: String)
  case stellar(unsignedXdr: String, networkPassphrase: String)
  case xaman(XamanRefs)
  case evm(transactionJson: String)

  public init?(json: JSONValue) {
    switch json["kind"]?.stringValue {
    case "xrpl":
      guard let tx = json["unsignedTransaction"],
            let data = try? JSONEncoder().encode(tx) else { return nil }
      self = .xrpl(unsignedTransactionJson: String(decoding: data, as: UTF8.self))
    case "stellar":
      guard let xdr = json["unsignedXdr"]?.stringValue,
            let passphrase = json["networkPassphrase"]?.stringValue else { return nil }
      self = .stellar(unsignedXdr: xdr, networkPassphrase: passphrase)
    case "xaman":
      guard let refs = try? json.decoded(XamanRefs.self) else { return nil }
      self = .xaman(refs)
    case "evm":
      guard let tx = json["transaction"],
            let data = try? JSONEncoder().encode(tx) else { return nil }
      self = .evm(transactionJson: String(decoding: data, as: UTF8.self))
    default:
      return nil
    }
  }
}

public struct TransferPrepared: Sendable {
  public let transfer: ActivityItem
  public let signingRequest: SigningRequest

  public init(transfer: ActivityItem, signingRequest: SigningRequest) {
    self.transfer = transfer
    self.signingRequest = signingRequest
  }
}

/// One row of `activity_list`. The server returns a union of DEX-order and
/// transfer records; this decodes the shared fields plus what each variant
/// adds, keeping unknown members in `raw` for detail views.
public struct ActivityItem: Sendable, Identifiable, Equatable {
  public enum Kind: String, Sendable {
    case order, transfer, unknown
  }

  public let id: String
  public let kind: Kind
  public let chain: String
  public let network: String
  public let status: String
  public let sourceAddress: String
  public let sourceKind: String
  public let zone: String?
  public let addressName: String?
  public let amount: String
  public let createdAt: String
  public let updatedAt: String
  public let transactionHash: String?
  /// Order-only.
  public let side: String?
  public let baseSymbol: String?
  public let quoteSymbol: String?
  public let limitPrice: String?
  /// Transfer-only.
  public let destinationAddress: String?
  public let assetSymbol: String?
  public let raw: JSONValue

  public init(json: JSONValue) {
    self.raw = json
    self.id = json["id"]?.stringValue ?? UUID().uuidString
    let kindTag = json["kind"]?.stringValue
    // DEX activity records carry no `kind` member; transfers say "transfer".
    self.kind = kindTag == "transfer" ? .transfer : (json["side"] != nil ? .order : .unknown)
    self.chain = json["chain"]?.stringValue ?? ""
    self.network = json["network"]?.stringValue ?? ""
    self.status = json["status"]?.stringValue ?? "unknown"
    self.sourceAddress = json["sourceAddress"]?.stringValue ?? ""
    self.sourceKind = json["sourceKind"]?.stringValue ?? ""
    self.zone = json["zone"]?.stringValue
    self.addressName = json["addressName"]?.stringValue
    self.amount = json["amount"]?.stringValue ?? ""
    self.createdAt = json["createdAt"]?.stringValue ?? ""
    self.updatedAt = json["updatedAt"]?.stringValue ?? ""
    self.transactionHash = json["transactionHash"]?.stringValue
    self.side = json["side"]?.stringValue
    self.baseSymbol = json["baseSymbol"]?.stringValue
    self.quoteSymbol = json["quoteSymbol"]?.stringValue
    self.limitPrice = json["limitPrice"]?.stringValue
    self.destinationAddress = json["destinationAddress"]?.stringValue
    self.assetSymbol = json["assetSymbol"]?.stringValue
  }
}
