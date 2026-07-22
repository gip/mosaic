import Foundation
import JavaScriptCore
import MosaicCore
import Security

/// The frozen zone crypto, running as the exact JS shipped in
/// `@mosaic/mobile-bridge` inside a networkless JSContext. The only host
/// capability injected is randomness (SecRandomCopyBytes); JSC has no
/// fetch/WebSocket, so key material never sits next to network reach.
///
/// Secrets pass through as hex strings. JSC gives no guaranteed zeroization
/// of JS strings — an accepted residual risk of the same class as browser
/// caches (ADR 0002); the context is discarded on `invalidate()`.
public actor ZoneCryptoEngine {
  public enum EngineError: Error, LocalizedError {
    case bundleMissing
    case javascript(String)
    case badResult

    public var errorDescription: String? {
      switch self {
      case .bundleMissing: return "mosaic-bridge.js resource is missing"
      case .javascript(let message): return message
      case .badResult: return "bridge returned an unexpected value"
      }
    }
  }

  private var context: JSContext?

  public init() {}

  /// SHA-256 of the embedded bundle, for support/diagnostics screens.
  public static func bundledDigest() -> String? {
    guard let url = Bundle.module.url(forResource: "mosaic-bridge", withExtension: "sha256"),
          let text = try? String(contentsOf: url, encoding: .utf8)
    else { return nil }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func bridge() throws -> JSValue {
    if let context, let value = context.globalObject.objectForKeyedSubscript("MosaicBridge"), !value.isUndefined {
      return value
    }
    guard let url = Bundle.module.url(forResource: "mosaic-bridge", withExtension: "js"),
          let source = try? String(contentsOf: url, encoding: .utf8)
    else { throw EngineError.bundleMissing }

    let fresh = JSContext()!
    var thrown: String?
    fresh.exceptionHandler = { _, exception in
      thrown = exception?.toString() ?? "unknown JS exception"
    }
    let randomBytes: @convention(block) (Int) -> [Int] = { length in
      var bytes = [UInt8](repeating: 0, count: length)
      let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
      precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
      return bytes.map(Int.init)
    }
    fresh.setObject(randomBytes, forKeyedSubscript: "__mosaicRandomBytes" as NSString)
    fresh.evaluateScript(source, withSourceURL: url)
    if let thrown { throw EngineError.javascript("bridge failed to load: \(thrown)") }
    guard let value = fresh.globalObject.objectForKeyedSubscript("MosaicBridge"), !value.isUndefined else {
      throw EngineError.javascript("bridge did not install MosaicBridge")
    }
    context = fresh
    return value
  }

  /// Drop the JS context (called on lock/logout). Best-effort scrubbing.
  public func invalidate() {
    context = nil
  }

  private func call(_ name: String, _ arguments: [Any]) throws -> JSValue {
    let bridge = try bridge()
    var thrown: String?
    context?.exceptionHandler = { _, exception in
      thrown = exception?.toString() ?? "unknown JS exception"
    }
    guard let result = bridge.invokeMethod(name, withArguments: arguments) else {
      throw EngineError.badResult
    }
    if let thrown { throw EngineError.javascript(thrown) }
    return result
  }

  private func callString(_ name: String, _ arguments: [Any]) throws -> String {
    let value = try call(name, arguments)
    guard value.isString, let string = value.toString() else { throw EngineError.badResult }
    return string
  }

  /// Await a JS promise. Bridge promises resolve from pure computation, so
  /// JSC drains the microtask queue before control returns to Swift; the
  /// continuation fires exactly once.
  private func awaitPromise(_ value: JSValue) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      let box = ContinuationBox(continuation)
      let onFulfilled: @convention(block) (JSValue) -> Void = { result in
        box.resume(.success(result.toString() ?? ""))
      }
      let onRejected: @convention(block) (JSValue) -> Void = { error in
        box.resume(.failure(EngineError.javascript(error.toString() ?? "promise rejected")))
      }
      value.invokeMethod("then", withArguments: [
        unsafeBitCast(onFulfilled, to: AnyObject.self),
        unsafeBitCast(onRejected, to: AnyObject.self),
      ])
    }
  }

  // MARK: - Bridge surface

  public struct AgentAddresses: Codable, Sendable {
    public let evm: String
    public let xrpl: String
    public let stellar: String

    public func address(for chain: AgentChain) -> String {
      switch chain {
      case .evm: return evm
      case .xrpl: return xrpl
      case .stellar: return stellar
      }
    }
  }

  public struct KdfParams: Codable, Sendable {
    public let saltHex: String
    public let m: Int
    public let t: Int
    public let p: Int
  }

  public func deriveAddresses(secretHex: String, ref: ZoneRef, index: Int) throws -> AgentAddresses {
    let json = try callString("deriveAddresses", [secretHex, ref.jsonString, index])
    return try JSONDecoder().decode(AgentAddresses.self, from: Data(json.utf8))
  }

  public func verifyCommitment(secretHex: String, commitment: String) throws -> Bool {
    let value = try call("verifyCommitment", [secretHex, commitment])
    return value.toBool()
  }

  public func openSignatureBlob(
    signatureHex: String, headerJson: String, ciphertextB64: String, ref: ZoneRef, commitment: String
  ) throws -> String {
    try callString("openSignatureBlob", [signatureHex, headerJson, ciphertextB64, ref.jsonString, commitment])
  }

  public func openPassphraseBlob(
    kekHex: String, headerJson: String, ciphertextB64: String, ref: ZoneRef, commitment: String
  ) throws -> String {
    try callString("openPassphraseBlob", [kekHex, headerJson, ciphertextB64, ref.jsonString, commitment])
  }

  public func passphraseKdfParams(headerJson: String, ciphertextB64: String) throws -> KdfParams {
    let json = try callString("passphraseKdfParams", [headerJson, ciphertextB64])
    return try JSONDecoder().decode(KdfParams.self, from: Data(json.utf8))
  }

  public func xrplTxnSignatureBytes(blobHex: String) throws -> String {
    try callString("xrplTxnSignatureBytes", [blobHex])
  }

  public func signXrplTransfer(
    unsignedTxJson: String, secretHex: String, ref: ZoneRef, index: Int, expectedAddress: String
  ) throws -> String {
    try callString("signXrplTransfer", [unsignedTxJson, secretHex, ref.jsonString, index, expectedAddress])
  }

  public func signStellarTransfer(
    unsignedXdr: String, network: Network, secretHex: String, ref: ZoneRef, index: Int, expectedAddress: String
  ) throws -> String {
    try callString("signStellarTransfer", [unsignedXdr, network.rawValue, secretHex, ref.jsonString, index, expectedAddress])
  }

  public func signEvmTransfer(
    txJson: String, secretHex: String, ref: ZoneRef, index: Int, expectedAddress: String
  ) async throws -> String {
    let promise = try call("signEvmTransfer", [txJson, secretHex, ref.jsonString, index, expectedAddress])
    return try await awaitPromise(promise)
  }

  public func guardianAddress(secretHex: String, ref: ZoneRef, index: Int) throws -> String {
    try callString("guardianAddress", [secretHex, ref.jsonString, index])
  }

  public func guardianSignText(secretHex: String, ref: ZoneRef, index: Int, text: String) throws -> String {
    try callString("guardianSignText", [secretHex, ref.jsonString, index, text])
  }

  // MARK: Companion protocol (ADR 0002) — same pure JS the desktop runs

  /// Validates a scanned pairing offer; throws on tamper. Returns offer JSON.
  public func companionVerifyOffer(offerJson: String) throws -> String {
    try callString("companionVerifyOffer", [offerJson])
  }

  /// Verifies a forward/resolved envelope against the guardian authority.
  public func companionVerifyEnvelope(envelopeJson: String, guardianAddress: String) throws -> String {
    try callString("companionVerifyEnvelope", [envelopeJson, guardianAddress])
  }

  /// Canonical companion-enrollment message to send over the transport.
  public func companionEnroll(
    offerJson: String, secretHex: String, ref: ZoneRef, companionInboxId: String, companionName: String, requestId: String
  ) throws -> String {
    try callString("companionEnroll", [offerJson, secretHex, ref.jsonString, companionInboxId, companionName, requestId])
  }

  /// Canonical approval-decision message (approve | reject | revoke).
  public func companionDecide(
    forwardJson: String, decision: String, reason: String, secretHex: String, ref: ZoneRef,
    authorityIndex: Int, companionInboxId: String, sequence: Int
  ) throws -> String {
    try callString("companionDecide", [forwardJson, decision, reason, secretHex, ref.jsonString, authorityIndex, companionInboxId, sequence])
  }
}

/// Single-fire continuation guard (JSC `then` callbacks are foreign code).
private final class ContinuationBox: @unchecked Sendable {
  private var continuation: CheckedContinuation<String, Error>?
  private let lock = NSLock()

  init(_ continuation: CheckedContinuation<String, Error>) {
    self.continuation = continuation
  }

  func resume(_ result: Result<String, Error>) {
    lock.lock()
    let taken = continuation
    continuation = nil
    lock.unlock()
    taken?.resume(with: result)
  }
}
