import XCTest
@testable import GuardianKit
@testable import MosaicCore
@testable import ZoneCryptoJS

/// Companion protocol conformance in the real JavaScriptCore, against
/// desktop-signed fixtures from generate-swift-fixtures.mjs.
final class CompanionTests: XCTestCase {
  struct Fixtures: Decodable {
    let secretHex: String
    let ref: ZoneRef
    let companion: Companion

    struct Companion: Decodable {
      let guardianAddress: String
      let authorityIndex: Int
      let expiredOfferJson: String
      let forwardJson: String
    }
  }

  private func fixtures() throws -> Fixtures {
    guard let url = Bundle.module.url(forResource: "swift-fixtures", withExtension: "json", subdirectory: "Fixtures") else {
      throw XCTSkip("missing swift-fixtures.json — run ios-app/scripts/sync-bridge.sh")
    }
    return try JSONDecoder().decode(Fixtures.self, from: try Data(contentsOf: url))
  }

  func testExpiredOfferIsRejected() async throws {
    let fixtures = try fixtures()
    let engine = ZoneCryptoEngine()
    do {
      _ = try await engine.companionVerifyOffer(offerJson: fixtures.companion.expiredOfferJson)
      XCTFail("expired companion offers must be rejected")
    } catch {
      XCTAssertTrue("\(error)".contains("expired"), "rejection must be for freshness: \(error)")
    }
  }

  func testForwardVerifiesAndDecisionRoundTrips() async throws {
    let fixtures = try fixtures()
    let engine = ZoneCryptoEngine()

    // The desktop-signed forward verifies against the guardian authority…
    let verified = try await engine.companionVerifyEnvelope(
      envelopeJson: fixtures.companion.forwardJson,
      guardianAddress: fixtures.companion.guardianAddress
    )
    XCTAssertFalse(verified.isEmpty)
    // …and against nothing else.
    do {
      _ = try await engine.companionVerifyEnvelope(
        envelopeJson: fixtures.companion.forwardJson,
        guardianAddress: "0x" + String(repeating: "22", count: 20)
      )
      XCTFail("forward must not verify under a different authority")
    } catch {}

    // Deciding derives the same authority key from the vault and produces an
    // envelope that self-verifies under the desktop's guardian address.
    let decision = try await engine.companionDecide(
      forwardJson: fixtures.companion.forwardJson,
      decision: "approve",
      reason: "",
      secretHex: fixtures.secretHex,
      ref: ZoneRef(rootChain: fixtures.ref.rootChain, rootAddress: fixtures.ref.rootAddress, zone: fixtures.ref.zone, network: fixtures.ref.network),
      authorityIndex: fixtures.companion.authorityIndex,
      companionInboxId: "phone-inbox",
      sequence: 3
    )
    let checked = try await engine.companionVerifyEnvelope(
      envelopeJson: decision,
      guardianAddress: fixtures.companion.guardianAddress
    )
    XCTAssertTrue(checked.contains("\"decision\":\"approve\""))
    XCTAssertTrue(checked.contains("fixture-req-1"))

    // Invalid decisions are refused before signing.
    do {
      _ = try await engine.companionDecide(
        forwardJson: fixtures.companion.forwardJson,
        decision: "detonate",
        reason: "",
        secretHex: fixtures.secretHex,
        ref: fixtures.ref,
        authorityIndex: fixtures.companion.authorityIndex,
        companionInboxId: "phone-inbox",
        sequence: 4
      )
      XCTFail("unknown decision kinds must throw")
    } catch {}
  }

  func testApprovalRequestParsesForwardEnvelope() throws {
    let fixtures = try fixtures()
    let request = try XCTUnwrap(ApprovalRequest(envelopeJson: fixtures.companion.forwardJson))
    XCTAssertEqual(request.requestId, "fixture-req-1")
    XCTAssertEqual(request.operation, "transaction.propose")
    XCTAssertEqual(request.summary["chain"], "xrpl")
    XCTAssertEqual(request.status, .pending)
  }

  func testLoopbackTransportDelivers() async throws {
    let transport = LoopbackCompanionTransport(inboxId: "phone-inbox")
    let stream = transport.messages()
    transport.deliver(from: "guardian-inbox", content: "hello")
    var iterator = stream.makeAsyncIterator()
    let message = await iterator.next()
    XCTAssertEqual(message?.content, "hello")
    XCTAssertEqual(message?.senderInboxId, "guardian-inbox")
    try await transport.send(to: "guardian-inbox", content: "reply")
    XCTAssertEqual(transport.outbox.first?.content, "reply")
    await transport.close()
  }
}
