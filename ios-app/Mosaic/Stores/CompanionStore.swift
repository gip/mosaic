import Foundation
import GuardianKit
import UIKit
import ZoneCryptoJS
import MCPClient
import MosaicCore
import Observation

/// Phone side of the companion Guardian (ADR 0002). Pairs with the desktop
/// Guardian via a signed offer QR, receives approval forwards over XMTP
/// (queued even while zones are locked), and answers with decisions signed by
/// the vault-derived guardian authority key behind Face ID.
@Observable @MainActor
final class CompanionStore {
  enum TransportState: Equatable {
    case idle
    case connecting
    case listening(inboxId: String)
    case failed(String)
  }

  private static let pairingKey = "mosaic.companion.pairing"
  private static let sequenceKey = "mosaic.companion.sequence"

  private(set) var pairing: CompanionPairing?
  private(set) var transportState: TransportState = .idle
  var approvals: [ApprovalRequest] = []
  var lastError: String?

  private var transport: XMTPCompanionTransport?
  private var listenTask: Task<Void, Never>?
  private var engine: ZoneCryptoEngine?

  init() {
    if let data = UserDefaults.standard.data(forKey: Self.pairingKey) {
      pairing = try? JSONDecoder().decode(CompanionPairing.self, from: data)
    }
  }

  // MARK: Pairing

  /// Scan/paste flow: verify the offer, enroll by signing with the guardian
  /// authority key (requires the offer's vault to be unlocked — Face ID).
  func pair(offerJson: String, model: AppModel) async {
    guard let auth = model.auth else { return }
    lastError = nil
    engine = model.vault.engine
    do {
      let verified = try await model.vault.engine.companionVerifyOffer(offerJson: offerJson)
      transportState = .connecting
      let transport = try await XMTPCompanionTransport.create(network: auth.network)
      self.transport = transport
      let pairing = try CompanionPairing(offerJson: verified, companionInboxId: transport.inboxId)
      guard pairing.network == auth.network else {
        throw CompanionError.networkMismatch(pairing.network.rawValue, auth.network.rawValue)
      }
      let ref = ZoneRef(rootChain: auth.chain, rootAddress: auth.address, zone: pairing.vault, network: auth.network)
      let enrollment = try await model.vault.withSecret(ref: ref, reason: "Pair with the desktop Guardian") { secretHex in
        try await model.vault.engine.companionEnroll(
          offerJson: verified,
          secretHex: secretHex,
          ref: ref,
          companionInboxId: transport.inboxId,
          companionName: UIDevice.current.name,
          requestId: UUID().uuidString
        )
      }
      try await transport.send(to: pairing.guardianControlInboxId, content: enrollment)
      self.pairing = pairing
      UserDefaults.standard.set(try? JSONEncoder().encode(pairing), forKey: Self.pairingKey)
      UserDefaults.standard.set(2, forKey: Self.sequenceKey)
      startListening()
    } catch {
      transportState = .failed(error.localizedDescription)
      lastError = error.localizedDescription
    }
  }

  func unpair() {
    listenTask?.cancel()
    listenTask = nil
    transport = nil
    pairing = nil
    approvals = []
    transportState = .idle
    UserDefaults.standard.removeObject(forKey: Self.pairingKey)
    UserDefaults.standard.removeObject(forKey: Self.sequenceKey)
  }

  // MARK: Listening

  func start(model: AppModel) async {
    guard pairing != nil, transport == nil, let auth = model.auth else { return }
    engine = model.vault.engine
    transportState = .connecting
    do {
      transport = try await XMTPCompanionTransport.create(network: auth.network)
      startListening()
    } catch {
      transportState = .failed(error.localizedDescription)
    }
  }

  private func startListening() {
    guard let transport, let pairing else { return }
    transportState = .listening(inboxId: transport.inboxId)
    listenTask?.cancel()
    listenTask = Task { [weak self] in
      for await message in transport.messages() {
        guard !Task.isCancelled else { return }
        await self?.handle(message: message)
      }
    }
  }

  private func handle(message: CompanionMessage) async {
    guard let pairing else { return }
    guard message.senderInboxId == pairing.guardianControlInboxId else { return }
    guard
      let json = try? JSONDecoder().decode(JSONValue.self, from: Data(message.content.utf8)),
      let kind = json["kind"]?.stringValue
    else { return }
    // Verification happens in the networkless crypto context.
    guard let engine else { return }
    switch kind {
    case "approval-forward":
      guard (try? await engine.companionVerifyEnvelope(envelopeJson: message.content, guardianAddress: pairing.guardianId)) != nil,
            let request = ApprovalRequest(envelopeJson: message.content)
      else { return }
      if !approvals.contains(where: { $0.requestId == request.requestId }) {
        approvals.insert(request, at: 0)
      }
    case "approval-resolved":
      guard (try? await engine.companionVerifyEnvelope(envelopeJson: message.content, guardianAddress: pairing.guardianId)) != nil,
            let requestId = json["requestId"]?.stringValue,
            let outcome = json["payload"]?["outcome"]?.stringValue
      else { return }
      updateStatus(requestId: requestId, outcome: outcome, detail: json["payload"]?["detail"]?.stringValue)
    default:
      break
    }
  }

  private func updateStatus(requestId: String, outcome: String, detail: String?) {
    guard let index = approvals.firstIndex(where: { $0.requestId == requestId }) else { return }
    var request = approvals[index]
    request.status = ApprovalRequest.Status(rawValue: outcome) ?? .failed
    request.detail = detail
    approvals[index] = request
  }

  // MARK: Decisions

  func decide(_ request: ApprovalRequest, decision: String, reason: String, model: AppModel) async {
    guard let auth = model.auth, let pairing, let transport else { return }
    guard let index = approvals.firstIndex(where: { $0.requestId == request.requestId }) else { return }
    approvals[index].status = .deciding
    do {
      let ref = ZoneRef(rootChain: auth.chain, rootAddress: auth.address, zone: pairing.vault, network: auth.network)
      let sequence = UserDefaults.standard.integer(forKey: Self.sequenceKey)
      let envelope = try await model.vault.withSecret(
        ref: ref,
        reason: "\(decision.capitalized) \(request.operation) request"
      ) { secretHex in
        try await model.vault.engine.companionDecide(
          forwardJson: request.envelopeJson,
          decision: decision,
          reason: reason,
          secretHex: secretHex,
          ref: ref,
          authorityIndex: pairing.authorityIndex,
          companionInboxId: pairing.companionInboxId,
          sequence: max(2, sequence)
        )
      }
      UserDefaults.standard.set(max(2, sequence) + 1, forKey: Self.sequenceKey)
      try await transport.send(to: pairing.guardianControlInboxId, content: envelope)
      // Terminal status arrives via approval-resolved; show interim state.
      if let current = approvals.firstIndex(where: { $0.requestId == request.requestId }) {
        approvals[current].detail = "Decision sent — waiting for the desktop Guardian."
      }
    } catch {
      if let current = approvals.firstIndex(where: { $0.requestId == request.requestId }) {
        approvals[current].status = .pending
        approvals[current].detail = error.localizedDescription
      }
    }
  }

  // MARK: Push registration

  func registerDevice(apnsTokenHex: String, model: AppModel) async {
    guard let auth = model.auth else { return }
    _ = try? await model.api.deviceRegister(
      token: auth.token,
      apnsToken: apnsTokenHex,
      deviceName: UIDevice.current.name,
      apnsEnvironment: "development"
    )
  }
}

enum CompanionError: Error, LocalizedError {
  case networkMismatch(String, String)

  var errorDescription: String? {
    if case .networkMismatch(let offer, let session) = self {
      return "The pairing offer is for \(offer) but this session is on \(session)."
    }
    return nil
  }
}
