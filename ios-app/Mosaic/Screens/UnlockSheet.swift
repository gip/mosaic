import MCPClient
import MosaicCore
import SwiftUI
import WalletLink

/// Unlock a zone: Face ID (cache hit), one Xaman backup-wrap re-signature
/// (XRPL roots), or the recovery passphrase. `backup-wrap` is signed here and
/// ONLY here — never during login.
struct UnlockSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  let zone: ZoneListItem

  @State private var flow = UnlockFlow()
  @State private var passphrase = ""
  @State private var showingPassphrase = false

  private var hasSigBlob: Bool {
    // zone_list does not carry blob kinds; layer 1 exists for signed zones.
    zone.mode == .signed
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 20) {
        Image(systemName: "lock.shield")
          .font(.system(size: 44))
          .foregroundStyle(.tint)
          .padding(.top, 24)
        Text("Unlock \(zone.zone)")
          .font(.title2.bold())
        Text("The zone secret is decrypted on this phone only; the server never sees it.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 28)

        switch flow.phase {
        case .idle, .failed:
          VStack(spacing: 12) {
            if flow.cacheAvailable {
              Button {
                flow.unlockFromCache(model: model, zone: zone) { dismiss() }
              } label: {
                Label("Unlock with Face ID", systemImage: "faceid")
                  .frame(maxWidth: .infinity)
              }
              .buttonStyle(.borderedProminent)
            }
            if let auth = model.auth, auth.chain != .xrpl, hasSigBlob {
              Button {
                flow.unlockWithWalletConnect(model: model, zone: zone) { dismiss() }
              } label: {
                Label(auth.chain == .evm ? "Re-sign with MetaMask" : "Re-sign with Stellar wallet", systemImage: "signature")
                  .frame(maxWidth: .infinity)
              }
              .buttonStyle(.bordered)
            }
            if model.auth?.chain == .xrpl && hasSigBlob {
              let xamanButton = Button {
                flow.unlockWithXaman(model: model, zone: zone, openURL: { openURL($0) }) { dismiss() }
              } label: {
                Label("Re-sign with Xaman", systemImage: "signature")
                  .frame(maxWidth: .infinity)
              }
              if flow.cacheAvailable {
                xamanButton.buttonStyle(.bordered)
              } else {
                xamanButton.buttonStyle(.borderedProminent)
              }
            }
            Button {
              showingPassphrase = true
            } label: {
              Label("Use recovery passphrase", systemImage: "key")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
          }
          .padding(.horizontal, 28)

          if case .failed(let message) = flow.phase {
            Text(message)
              .font(.footnote)
              .foregroundStyle(.red)
              .multilineTextAlignment(.center)
              .padding(.horizontal)
          }

        case .xamanWaiting(let refs):
          XamanRequestView(refs: refs, status: "Sign the backup key request in Xaman…") {
            flow.cancel()
          }

        case .wcPairing(let uri):
          WalletConnectPairingView(uri: uri, chain: model.auth?.chain ?? .evm) {
            flow.cancel()
          }

        case .working(let message):
          ProgressView(message)
            .padding(.vertical, 24)
        }

        Spacer()
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            flow.cancel()
            dismiss()
          }
        }
      }
      .onAppear {
        flow.prepare(model: model, zone: zone)
      }
      .sheet(isPresented: $showingPassphrase) {
        PassphraseSheet(passphrase: $passphrase) {
          showingPassphrase = false
          flow.unlockWithPassphrase(model: model, zone: zone, passphrase: passphrase) {
            passphrase = ""
            dismiss()
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

@Observable @MainActor
final class UnlockFlow {
  enum Phase {
    case idle
    case xamanWaiting(XamanRefs)
    case wcPairing(String)
    case working(String)
    case failed(String)
  }

  var phase: Phase = .idle
  var cacheAvailable = false
  private var task: Task<Void, Never>?

  func prepare(model: AppModel, zone: ZoneListItem) {
    guard let auth = model.auth else { return }
    cacheAvailable = model.vault.hasCachedSecret(ref: model.vault.ref(for: zone, auth: auth))
  }

  func unlockFromCache(model: AppModel, zone: ZoneListItem, done: @escaping () -> Void) {
    guard let auth = model.auth else { return }
    run {
      self.phase = .working("Unlocking…")
      let hit = try await model.vault.unlockFromCache(zone: zone, auth: auth, api: model.api)
      if hit {
        done()
      } else {
        self.cacheAvailable = false
        self.phase = .failed("Face ID unlock is unavailable — re-sign with your wallet or use the passphrase.")
      }
    }
  }

  func unlockWithXaman(
    model: AppModel, zone: ZoneListItem, openURL: @escaping (URL) -> Void, done: @escaping () -> Void
  ) {
    guard let auth = model.auth else { return }
    run {
      let refs = try await model.api.xamanSignCreate(token: auth.token, purpose: "backup-wrap", zone: zone.zone)
      self.phase = .xamanWaiting(refs)
      if let deeplink = URL(string: refs.deeplink) { openURL(deeplink) }
      let outcome = try await XamanLink(refs: refs).waitForResolution()
      guard case .signed = outcome else {
        self.phase = .failed(outcome == .rejected ? "The request was rejected in Xaman." : "The request expired.")
        return
      }
      self.phase = .working("Opening the recovery blob…")
      let payload = try await model.api.xamanPayloadResult(token: auth.token, uuid: refs.uuid)
      guard payload.signed, let hex = payload.hex else {
        self.phase = .failed("Xaman returned no signed payload.")
        return
      }
      try await model.vault.unlockWithXamanBlob(zone: zone, auth: auth, api: model.api, signedBlobHex: hex)
      done()
    }
  }

  func unlockWithWalletConnect(model: AppModel, zone: ZoneListItem, done: @escaping () -> Void) {
    guard let auth = model.auth else { return }
    run {
      self.phase = .working("Connecting to the wallet…")
      let ref = model.vault.ref(for: zone, auth: auth)
      let signatureHex = try await WalletConnectBackupWrap.signatureHex(model: model, auth: auth, ref: ref) { uri in
        Task { @MainActor in self.phase = .wcPairing(uri) }
      }
      self.phase = .working("Opening the recovery blob…")
      try await model.vault.unlockWithSignatureBytes(zone: zone, auth: auth, api: model.api, signatureHex: signatureHex)
      done()
    }
  }

  func unlockWithPassphrase(model: AppModel, zone: ZoneListItem, passphrase: String, done: @escaping () -> Void) {
    guard let auth = model.auth, !passphrase.isEmpty else { return }
    run {
      self.phase = .working("Deriving key from passphrase…")
      try await model.vault.unlockWithPassphrase(zone: zone, auth: auth, api: model.api, passphrase: passphrase)
      done()
    }
  }

  func cancel() {
    task?.cancel()
    phase = .idle
  }

  private func run(_ body: @escaping () async throws -> Void) {
    task?.cancel()
    task = Task {
      do {
        try await body()
      } catch is CancellationError {
        self.phase = .idle
      } catch {
        self.phase = .failed(error.localizedDescription)
      }
    }
  }
}

struct PassphraseSheet: View {
  @Binding var passphrase: String
  let submit: () -> Void

  var body: some View {
    NavigationStack {
      Form {
        Section {
          SecureField("Recovery passphrase", text: $passphrase)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } footer: {
          Text("Argon2id runs on this phone (256 MiB, ~seconds). The passphrase never leaves the device.")
        }
        Button("Unlock") { submit() }
          .disabled(passphrase.isEmpty)
      }
      .navigationTitle("Passphrase")
      .navigationBarTitleDisplayMode(.inline)
    }
    .presentationDetents([.medium])
  }
}

/// Shared Xaman payload prompt: deeplink button + QR fallback.
struct XamanRequestView: View {
  let refs: XamanRefs
  let status: String
  let cancel: () -> Void
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(spacing: 16) {
      if let qr = URL(string: refs.qrPng) {
        AsyncImage(url: qr) { image in
          image.resizable().scaledToFit()
        } placeholder: {
          ProgressView()
        }
        .frame(width: 180, height: 180)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 12))
      }
      if let deeplink = URL(string: refs.deeplink) {
        Button {
          openURL(deeplink)
        } label: {
          Label("Open in Xaman", systemImage: "arrow.up.forward.app")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .padding(.horizontal, 40)
      }
      Label(status, systemImage: "hourglass")
        .font(.footnote)
        .foregroundStyle(.secondary)
      Button("Cancel", role: .cancel) { cancel() }
    }
  }
}
