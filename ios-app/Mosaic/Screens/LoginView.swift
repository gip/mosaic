import MCPClient
import MosaicCore
import SwiftUI
import WalletLink

/// Root-wallet login. XRPL goes through a server-created Xaman payload —
/// opened via deeplink on this device or scanned as a QR from another one.
/// EVM/Stellar arrive with the WalletConnect integration.
struct LoginView: View {
  @Environment(AppModel.self) private var model
  @State private var network: Network = .testnet
  @State private var flow = XamanLoginFlow()

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Spacer()
        Image(systemName: "circle.hexagongrid.fill")
          .font(.system(size: 56))
          .foregroundStyle(.tint)
        Text("Mosaic")
          .font(.largeTitle.bold())
        Text("Log in with your root wallet to monitor zones and approve agent actions.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal)

        Picker("Network", selection: $network) {
          Text("Testnet").tag(Network.testnet)
          Text("Mainnet").tag(Network.mainnet)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 40)

        VStack(spacing: 12) {
          Button {
            flow.start(model: model, network: network)
          } label: {
            Label("Continue with Xaman (XRPL)", systemImage: "qrcode")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)

          Button {} label: {
            Label("MetaMask (EVM) — coming soon", systemImage: "link")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(true)

          Button {} label: {
            Label("Stellar wallet — coming soon", systemImage: "link")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(true)
        }
        .padding(.horizontal, 32)

        if let error = flow.errorMessage {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
            .padding(.horizontal)
        }
        Spacer()
      }
      .sheet(isPresented: $flow.showingPayload) {
        XamanPayloadSheet(flow: flow)
      }
    }
  }
}

/// Drives one Xaman login attempt: challenge → payload open/QR → websocket
/// resolution → verify.
@Observable @MainActor
final class XamanLoginFlow {
  var showingPayload = false
  var refs: XamanRefs?
  var status = "Waiting for signature in Xaman…"
  var errorMessage: String?
  private var task: Task<Void, Never>?

  func start(model: AppModel, network: Network) {
    errorMessage = nil
    task?.cancel()
    task = Task {
      do {
        let challenge = try await model.api.authChallenge(chain: .xrpl, network: network)
        guard let xaman = challenge.xaman else {
          throw MCPError.transport("server did not return a Xaman payload")
        }
        self.refs = xaman
        self.status = "Waiting for signature in Xaman…"
        self.showingPayload = true
        let link = XamanLink(refs: xaman)
        switch try await link.waitForResolution() {
        case .signed:
          self.status = "Verifying signature…"
          let auth = try await model.api.authVerify(
            challengeId: challenge.challengeId,
            signature: .xrpl(payloadUuid: xaman.uuid)
          )
          self.showingPayload = false
          model.adopt(session: auth)
        case .rejected:
          self.fail("Signature request was rejected in Xaman.")
        case .expired:
          self.fail("The signing request expired. Try again.")
        }
      } catch is CancellationError {
        // User dismissed the sheet.
      } catch {
        self.fail(error.localizedDescription)
      }
    }
  }

  func cancel() {
    task?.cancel()
    showingPayload = false
  }

  private func fail(_ message: String) {
    showingPayload = false
    errorMessage = message
  }
}

struct XamanPayloadSheet: View {
  @Bindable var flow: XamanLoginFlow
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(spacing: 20) {
      Text("Sign in with Xaman")
        .font(.title2.bold())
        .padding(.top, 24)
      Text("Open the request in the Xaman app on this phone, or scan the QR code with Xaman on another device.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal)

      if let refs = flow.refs, let qr = URL(string: refs.qrPng) {
        AsyncImage(url: qr) { image in
          image.resizable().scaledToFit()
        } placeholder: {
          ProgressView()
        }
        .frame(width: 220, height: 220)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 12))
      }

      if let refs = flow.refs, let deeplink = URL(string: refs.deeplink) {
        Button {
          openURL(deeplink)
        } label: {
          Label("Open in Xaman", systemImage: "arrow.up.forward.app")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .padding(.horizontal, 32)
      }

      Label(flow.status, systemImage: "hourglass")
        .font(.footnote)
        .foregroundStyle(.secondary)

      Button("Cancel", role: .cancel) { flow.cancel() }
        .padding(.bottom, 24)
      Spacer(minLength: 0)
    }
    .presentationDetents([.large])
    .interactiveDismissDisabled(false)
    .onDisappear {
      if flow.showingPayload { flow.cancel() }
    }
  }
}
