import Foundation
import MosaicCore

/// A companion-offer QR payload, as verified by the crypto bridge.
public struct CompanionPairing: Codable, Sendable, Equatable {
  public let guardianId: String
  public let guardianControlInboxId: String
  /// Zone (vault) name + agent index of the guardian authority — the phone
  /// derives the same key from this vault after unlock.
  public let vault: String
  public let authorityIndex: Int
  public let network: Network
  public let companionInboxId: String
  public let pairedAt: Date

  public init(offerJson: String, companionInboxId: String) throws {
    struct Offer: Decodable {
      let guardianId: String
      let guardianControlInboxId: String
      let vault: String
      let authorityIndex: Int
      let network: Network
    }
    let offer = try JSONDecoder().decode(Offer.self, from: Data(offerJson.utf8))
    self.guardianId = offer.guardianId
    self.guardianControlInboxId = offer.guardianControlInboxId
    self.vault = offer.vault
    self.authorityIndex = offer.authorityIndex
    self.network = offer.network
    self.companionInboxId = companionInboxId
    self.pairedAt = Date()
  }
}

/// One approval waiting for (or already given) a decision on this phone.
public struct ApprovalRequest: Identifiable, Sendable, Equatable {
  public enum Status: String, Sendable {
    case pending
    case deciding
    case approved
    case rejected
    case revoked
    case expired
    case failed
  }

  public let requestId: String
  public let operation: String
  public let agentId: String?
  public let grantId: String?
  public let network: String
  public let summary: [String: String]
  public let receivedAt: Date
  public let expiresAt: String
  /// Full verified forward envelope JSON — the input to companionDecide.
  public let envelopeJson: String
  public var status: Status
  public var detail: String?

  public var id: String { requestId }

  public init?(envelopeJson: String) {
    guard
      let data = envelopeJson.data(using: .utf8),
      let envelope = try? JSONDecoder().decode(JSONValue.self, from: data),
      let requestId = envelope["requestId"]?.stringValue,
      let payload = envelope["payload"]
    else { return nil }
    self.requestId = requestId
    self.operation = payload["operation"]?.stringValue ?? "unknown"
    self.agentId = payload["agentId"]?.stringValue
    self.grantId = payload["grantId"]?.stringValue
    self.network = payload["network"]?.stringValue ?? ""
    var summary: [String: String] = [:]
    if let fields = payload["summary"]?.objectValue {
      for (key, value) in fields {
        summary[key] = value.stringValue ?? String(describing: value)
      }
    }
    self.summary = summary
    self.receivedAt = Date()
    self.expiresAt = envelope["expiresAt"]?.stringValue ?? ""
    self.envelopeJson = envelopeJson
    self.status = .pending
    self.detail = nil
  }
}
