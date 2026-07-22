import Foundation
import Sodium

/// Argon2id via libsodium (`crypto_pwhash` alg argon2id13) — RFC 9106, the
/// same function hash-wasm computes on web. Cross-library equivalence is
/// asserted by the argon2-kat.json vectors in both CI stacks. libsodium
/// hard-codes parallelism 1, which matches the frozen ARGON2_PARAMS_V1.
public enum Argon2 {
  public enum Argon2Error: Error, LocalizedError {
    case unsupportedParams(String)
    case failed

    public var errorDescription: String? {
      switch self {
      case .unsupportedParams(let detail): return "unsupported Argon2 parameters: \(detail)"
      case .failed: return "Argon2id key derivation failed"
      }
    }
  }

  /// Derive a 32-byte kek. `m` is in KiB (as stored in blob headers), `t` is
  /// iterations, `p` must be 1.
  public static func deriveKek(passphrase: String, salt: [UInt8], m: Int, t: Int, p: Int) throws -> [UInt8] {
    guard p == 1 else { throw Argon2Error.unsupportedParams("p=\(p)") }
    guard salt.count == 16 else { throw Argon2Error.unsupportedParams("salt length \(salt.count)") }
    let sodium = Sodium()
    guard
      let kek = sodium.pwHash.hash(
        outputLength: 32,
        passwd: Array(passphrase.utf8),
        salt: salt,
        opsLimit: t,
        memLimit: m * 1024,
        alg: .Argon2ID13
      )
    else { throw Argon2Error.failed }
    return kek
  }
}
