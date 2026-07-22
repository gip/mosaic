import XCTest
@testable import MosaicCore
@testable import ZoneCryptoJS

/// Golden-vector and Node-parity conformance in the REAL JavaScriptCore —
/// the same engine the app ships. Fixtures are produced by
/// packages/mobile-bridge/scripts/generate-swift-fixtures.mjs; blobs sealed
/// and transactions signed in Node must open/sign byte-identically here.
final class ZoneCryptoTests: XCTestCase {
  private static func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
      throw XCTSkip("missing fixture \(name).json — run ios-app/scripts/sync-bridge.sh")
    }
    return try JSONDecoder().decode(type, from: try Data(contentsOf: url))
  }

  struct ZoneVectors: Decodable {
    let zoneRootSecret: String
    let cases: [Case]

    struct Case: Decodable {
      let rootChain: RootChain
      let rootAddress: String
      let zone: String
      let network: Network
      let agents: [String: [String: String]]
    }
  }

  struct SwiftFixtures: Decodable {
    let secretHex: String
    let ref: ZoneRef
    let commitment: String
    let addresses0: [String: String]
    let signatureBlob: SignatureBlob
    let passphraseBlob: PassphraseBlob
    let xrplSignIn: XrplSignIn
    let signing: Signing

    struct SignatureBlob: Decodable {
      let signatureHex: String
      let headerJson: String
      let ciphertextB64: String
    }

    struct PassphraseBlob: Decodable {
      let kekHex: String
      let passphrase: String
      let headerJson: String
      let ciphertextB64: String
    }

    struct XrplSignIn: Decodable {
      let blobHex: String
      let txnSignatureHex: String
    }

    struct Signing: Decodable {
      let xrpl: Xrpl
      let stellar: Stellar
      let evm: Evm

      struct Xrpl: Decodable {
        let unsignedJson: String
        let expectedTxBlob: String
      }

      struct Stellar: Decodable {
        let unsignedXdr: String
        let network: Network
        let expectedSignedXdr: String
      }

      struct Evm: Decodable {
        let unsignedJson: String
        let expectedSerialized: String
      }
    }
  }

  struct ArgonKat: Decodable {
    let reduced: [Case]
    let full: [Case]

    struct Case: Decodable {
      let passphrase: String
      let saltHex: String
      let m: Int
      let t: Int
      let p: Int
      let kekHex: String
    }
  }

  func testGoldenVectorsDeriveIdenticalAddressesInJSC() async throws {
    let vectors = try Self.fixture("zone-vectors", as: ZoneVectors.self)
    let engine = ZoneCryptoEngine()
    for kase in vectors.cases {
      let ref = ZoneRef(rootChain: kase.rootChain, rootAddress: kase.rootAddress, zone: kase.zone, network: kase.network)
      for (index, expected) in kase.agents {
        let derived = try await engine.deriveAddresses(secretHex: vectors.zoneRootSecret, ref: ref, index: Int(index)!)
        XCTAssertEqual(derived.evm, expected["evm"], "\(kase.zone)/\(kase.network)#\(index)")
        XCTAssertEqual(derived.xrpl, expected["xrpl"])
        XCTAssertEqual(derived.stellar, expected["stellar"])
      }
    }
  }

  func testCommitmentVerification() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()
    let valid = try await engine.verifyCommitment(secretHex: fixtures.secretHex, commitment: fixtures.commitment)
    XCTAssertTrue(valid)
    let broken = "00" + fixtures.commitment.dropFirst(2)
    let invalid = try await engine.verifyCommitment(secretHex: fixtures.secretHex, commitment: broken)
    XCTAssertFalse(invalid)
  }

  func testSignatureBlobSealedInNodeOpensInJSC() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()
    let secret = try await engine.openSignatureBlob(
      signatureHex: fixtures.signatureBlob.signatureHex,
      headerJson: fixtures.signatureBlob.headerJson,
      ciphertextB64: fixtures.signatureBlob.ciphertextB64,
      ref: fixtures.ref,
      commitment: fixtures.commitment
    )
    XCTAssertEqual(secret, fixtures.secretHex)

    // Wrong commitment must throw, never return a secret.
    do {
      _ = try await engine.openSignatureBlob(
        signatureHex: fixtures.signatureBlob.signatureHex,
        headerJson: fixtures.signatureBlob.headerJson,
        ciphertextB64: fixtures.signatureBlob.ciphertextB64,
        ref: fixtures.ref,
        commitment: "00" + fixtures.commitment.dropFirst(2)
      )
      XCTFail("expected commitment mismatch to throw")
    } catch {}
  }

  func testPassphraseBlobViaSodiumArgon2OpensInJSC() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()
    let params = try await engine.passphraseKdfParams(
      headerJson: fixtures.passphraseBlob.headerJson,
      ciphertextB64: fixtures.passphraseBlob.ciphertextB64
    )
    XCTAssertEqual(params.m, 262_144)

    // The fixture kek was computed with hash-wasm at reduced params; sodium
    // must reproduce it exactly (KAT), and the blob must open with it.
    let kat = try Self.fixture("argon2-kat", as: ArgonKat.self).reduced[0]
    let salt = try XCTUnwrap(Data(hexString: kat.saltHex))
    let kek = try Argon2.deriveKek(passphrase: kat.passphrase, salt: Array(salt), m: kat.m, t: kat.t, p: kat.p)
    XCTAssertEqual(kek.hexString, kat.kekHex)
    XCTAssertEqual(kek.hexString, fixtures.passphraseBlob.kekHex)

    let secret = try await engine.openPassphraseBlob(
      kekHex: kek.hexString,
      headerJson: fixtures.passphraseBlob.headerJson,
      ciphertextB64: fixtures.passphraseBlob.ciphertextB64,
      ref: fixtures.ref,
      commitment: fixtures.commitment
    )
    XCTAssertEqual(secret, fixtures.secretHex)
  }

  func testArgon2SodiumMatchesAllHashWasmKats() throws {
    let kats = try Self.fixture("argon2-kat", as: ArgonKat.self)
    for kat in kats.reduced {
      let salt = try XCTUnwrap(Data(hexString: kat.saltHex))
      let kek = try Argon2.deriveKek(passphrase: kat.passphrase, salt: Array(salt), m: kat.m, t: kat.t, p: kat.p)
      XCTAssertEqual(kek.hexString, kat.kekHex, "reduced KAT for \(kat.passphrase.prefix(8))…")
    }
    // One full ARGON2_PARAMS_V1 case (256 MiB) — the production path.
    let full = kats.full[0]
    let salt = try XCTUnwrap(Data(hexString: full.saltHex))
    let kek = try Argon2.deriveKek(passphrase: full.passphrase, salt: Array(salt), m: full.m, t: full.t, p: full.p)
    XCTAssertEqual(kek.hexString, full.kekHex)
  }

  func testXrplTxnSignatureExtraction() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()
    let extracted = try await engine.xrplTxnSignatureBytes(blobHex: fixtures.xrplSignIn.blobHex)
    XCTAssertEqual(extracted, fixtures.xrplSignIn.txnSignatureHex)
  }

  func testTransferSigningMatchesNodeOutputs() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()

    let xrpl = try await engine.signXrplTransfer(
      unsignedTxJson: fixtures.signing.xrpl.unsignedJson,
      secretHex: fixtures.secretHex,
      ref: fixtures.ref,
      index: 0,
      expectedAddress: fixtures.addresses0["xrpl"]!
    )
    XCTAssertEqual(xrpl, fixtures.signing.xrpl.expectedTxBlob)

    let stellar = try await engine.signStellarTransfer(
      unsignedXdr: fixtures.signing.stellar.unsignedXdr,
      network: fixtures.signing.stellar.network,
      secretHex: fixtures.secretHex,
      ref: fixtures.ref,
      index: 0,
      expectedAddress: fixtures.addresses0["stellar"]!
    )
    XCTAssertEqual(stellar, fixtures.signing.stellar.expectedSignedXdr)

    let evm = try await engine.signEvmTransfer(
      txJson: fixtures.signing.evm.unsignedJson,
      secretHex: fixtures.secretHex,
      ref: fixtures.ref,
      index: 0,
      expectedAddress: fixtures.addresses0["evm"]!
    )
    XCTAssertEqual(evm, fixtures.signing.evm.expectedSerialized)

    // Address mismatch must refuse to sign.
    do {
      _ = try await engine.signXrplTransfer(
        unsignedTxJson: fixtures.signing.xrpl.unsignedJson,
        secretHex: fixtures.secretHex,
        ref: fixtures.ref,
        index: 0,
        expectedAddress: "rWrongAddress"
      )
      XCTFail("expected address mismatch to throw")
    } catch {}
  }

  func testGuardianIdentityAndSignature() async throws {
    let fixtures = try Self.fixture("swift-fixtures", as: SwiftFixtures.self)
    let engine = ZoneCryptoEngine()
    let address = try await engine.guardianAddress(secretHex: fixtures.secretHex, ref: fixtures.ref, index: 0)
    XCTAssertEqual(address, fixtures.addresses0["evm"])
    let signature = try await engine.guardianSignText(
      secretHex: fixtures.secretHex, ref: fixtures.ref, index: 0, text: "companion"
    )
    XCTAssertEqual(signature.count, 130) // 65 bytes hex: r||s||v
  }
}

extension Data {
  init?(hexString: String) {
    let clean = hexString.hasPrefix("0x") ? String(hexString.dropFirst(2)) : hexString
    guard clean.count % 2 == 0 else { return nil }
    var bytes = [UInt8]()
    var index = clean.startIndex
    while index < clean.endIndex {
      let next = clean.index(index, offsetBy: 2)
      guard let byte = UInt8(clean[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}

extension Array where Element == UInt8 {
  var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
