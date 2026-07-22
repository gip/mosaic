import MCPClient
import MosaicCore
import SwiftUI
import WalletLink
import ZoneCryptoJS

/// WalletConnect login for EVM (MetaMask mobile) and Stellar wallets:
/// connect (deeplink/QR) → auth_challenge with the connected address → the
/// wallet signs the canonical session-auth message → auth_verify.
@Observable @MainActor
final class WalletConnectLoginFlow {
  enum Phase {
    case idle
    case pairing(uri: String, chain: RootChain)
    case waitingSignature
    case failed(String)
  }

  var phase: Phase = .idle
  private var task: Task<Void, Never>?

  func start(model: AppModel, chain: RootChain, network: Network) {
    let projectId = AppConfig.walletConnectProjectId
    guard !projectId.isEmpty else {
      phase = .failed("Set a WalletConnect project id in Settings first.")
      return
    }
    WalletConnectLink.configure(projectId: projectId)
    task?.cancel()
    task = Task {
      do {
        let chainId = chain == .evm
          ? WalletConnectLink.evmChainId(network: network)
          : WalletConnectLink.stellarChainId(network: network)
        let methods = chain == .evm ? ["eth_signTypedData_v4"] : ["stellar_signMessage", "stellar_signXDR"]
        let session = try await WalletConnectLink.connect(chainId: chainId, methods: methods) { uri in
          Task { @MainActor in
            self.phase = .pairing(uri: uri, chain: chain)
            let deeplink = chain == .evm
              ? WalletConnectLink.metamaskLink(uri: uri)
              : WalletConnectLink.freighterLink(uri: uri)
            if let deeplink {
              await UIApplication.shared.open(deeplink)
            }
          }
        }
        self.phase = .waitingSignature

        let challenge = try await model.api.authChallenge(chain: chain, network: network, address: session.address)
        let messageData = try JSONEncoder().encode(challenge.message)
        let messageJson = String(decoding: messageData, as: UTF8.self)

        let envelope: SignatureEnvelope
        if chain == .evm {
          let payload = try await model.vault.engine.evmSignTypedDataPayload(messageJson: messageJson, network: network)
          let paramsJson = try String(
            decoding: JSONEncoder().encode([JSONValue.string(session.address), JSONValue.string(payload)]),
            as: UTF8.self
          )
          let result = try await WalletConnectLink.request(
            session: session, method: "eth_signTypedData_v4", paramsJson: paramsJson
          )
          guard let signature = result.stringValue, signature.hasPrefix("0x") else {
            throw WalletConnectLink.WCError.badResponse("wallet returned no signature")
          }
          envelope = .evm(signature: signature)
        } else {
          let canonical = try await model.vault.engine.canonicalZoneMessageJson(messageJson: messageJson)
          let result = try await WalletConnectLink.request(
            session: session,
            method: "stellar_signMessage",
            paramsJson: String(
              decoding: try JSONEncoder().encode(["message": JSONValue.string(canonical)]),
              as: UTF8.self
            )
          )
          guard let signed = result["signedMessage"]?.stringValue ?? result["signature"]?.stringValue ?? result.stringValue else {
            throw WalletConnectLink.WCError.badResponse("wallet returned no signed message")
          }
          envelope = .stellar(signatureB64: signed)
        }
        let auth = try await model.api.authVerify(challengeId: challenge.challengeId, signature: envelope)
        self.phase = .idle
        model.adopt(session: auth)
      } catch is CancellationError {
        self.phase = .idle
      } catch {
        self.phase = .failed(error.localizedDescription)
      }
    }
  }

  func cancel() {
    task?.cancel()
    phase = .idle
  }
}

/// Backup-wrap re-signature over WalletConnect for EVM/Stellar root wallets:
/// the raw signature bytes are the layer-1 wrapKey ikm.
enum WalletConnectBackupWrap {
  static func signatureHex(model: AppModel, auth: AuthVerifyResult, ref: ZoneRef, onURI: @escaping (String) -> Void) async throws -> String {
    let projectId = AppConfig.walletConnectProjectId
    guard !projectId.isEmpty else { throw WalletConnectLink.WCError.notConfigured }
    WalletConnectLink.configure(projectId: projectId)
    let chainId = auth.chain == .evm
      ? WalletConnectLink.evmChainId(network: auth.network)
      : WalletConnectLink.stellarChainId(network: auth.network)
    let methods = auth.chain == .evm ? ["eth_signTypedData_v4"] : ["stellar_signMessage"]
    let session = try await WalletConnectLink.connect(chainId: chainId, methods: methods, onPairingURI: onURI)
    guard sameRootAddress(chain: auth.chain, session.address, auth.address) else {
      throw WalletConnectLink.WCError.badResponse(
        "The connected wallet (\(session.address)) is not this session's root wallet."
      )
    }
    let messageJson = try await model.vault.engine.backupWrapMessageJson(ref: ref)
    if auth.chain == .evm {
      let payload = try await model.vault.engine.evmSignTypedDataPayload(messageJson: messageJson, network: auth.network)
      let paramsJson = try String(
        decoding: JSONEncoder().encode([JSONValue.string(session.address), JSONValue.string(payload)]),
        as: UTF8.self
      )
      let result = try await WalletConnectLink.request(session: session, method: "eth_signTypedData_v4", paramsJson: paramsJson)
      guard let signature = result.stringValue, signature.hasPrefix("0x") else {
        throw WalletConnectLink.WCError.badResponse("wallet returned no signature")
      }
      return String(signature.dropFirst(2))
    }
    let canonical = try await model.vault.engine.canonicalZoneMessageJson(messageJson: messageJson)
    let result = try await WalletConnectLink.request(
      session: session,
      method: "stellar_signMessage",
      paramsJson: String(decoding: try JSONEncoder().encode(["message": JSONValue.string(canonical)]), as: UTF8.self)
    )
    guard let signed = result["signedMessage"]?.stringValue ?? result["signature"]?.stringValue ?? result.stringValue,
          let bytes = Data(base64Encoded: signed)
    else { throw WalletConnectLink.WCError.badResponse("wallet returned no signed message") }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  private static func sameRootAddress(chain: RootChain, _ a: String, _ b: String) -> Bool {
    chain == .evm ? a.lowercased() == b.lowercased() : a == b
  }
}

/// Shared WC pairing prompt: QR of the `wc:` URI + wallet deeplink button.
struct WalletConnectPairingView: View {
  let uri: String
  let chain: RootChain
  let cancel: () -> Void
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(spacing: 16) {
      Text(chain == .evm ? "Approve in MetaMask" : "Approve in your Stellar wallet")
        .font(.headline)
      QRCodeView(text: uri)
        .frame(width: 200, height: 200)
      if let deeplink = chain == .evm
        ? WalletConnectLink.metamaskLink(uri: uri)
        : WalletConnectLink.freighterLink(uri: uri) {
        Button {
          openURL(deeplink)
        } label: {
          Label(chain == .evm ? "Open MetaMask" : "Open wallet", systemImage: "arrow.up.forward.app")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .padding(.horizontal, 40)
      }
      Button("Cancel", role: .cancel) { cancel() }
    }
    .padding(.vertical, 20)
  }
}

/// CoreImage QR renderer (no external deps).
struct QRCodeView: View {
  let text: String

  var body: some View {
    if let image = Self.generate(text: text) {
      Image(uiImage: image)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    } else {
      Image(systemName: "xmark.square")
    }
  }

  static func generate(text: String) -> UIImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
    let context = CIContext()
    guard let cgImage = context.createCGImage(output, from: output.extent) else { return nil }
    return UIImage(cgImage: cgImage)
  }
}
