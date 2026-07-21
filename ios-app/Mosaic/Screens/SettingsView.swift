import MosaicCore
import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var serverURLText = AppConfig.mcpURL.absoluteString
  @State private var showingLogoutConfirm = false

  var body: some View {
    Form {
      if let auth = model.auth {
        Section("Session") {
          LabeledContent("Wallet", value: auth.chain.displayName)
          LabeledContent("Address") {
            Text(auth.address)
              .font(.caption.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Picker("Network", selection: networkBinding(auth.network)) {
            Text("Testnet").tag(Network.testnet)
            Text("Mainnet").tag(Network.mainnet)
          }
        }
      }

      Section {
        TextField("MCP server URL", text: $serverURLText)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.callout.monospaced())
        Button("Apply server URL") {
          applyServerURL()
        }
        .disabled(URL(string: serverURLText)?.scheme == nil)
      } header: {
        Text("Server")
      } footer: {
        Text("Changing the server ends the current session. Default: \(AppConfig.defaultMCPURL.absoluteString)")
      }

      Section {
        Button("Log out", role: .destructive) {
          showingLogoutConfirm = true
        }
      }
    }
    .navigationTitle("Settings")
    .confirmationDialog("Log out of this session?", isPresented: $showingLogoutConfirm, titleVisibility: .visible) {
      Button("Log out", role: .destructive) {
        Task { await model.logout() }
      }
    }
  }

  private func networkBinding(_ current: Network) -> Binding<Network> {
    Binding(
      get: { current },
      set: { newValue in Task { await model.switchNetwork(newValue) } }
    )
  }

  private func applyServerURL() {
    guard let url = URL(string: serverURLText), url.scheme != nil else { return }
    AppConfig.mcpURL = url
    Task {
      await model.logout()
      await model.api.setServer(url: url)
    }
  }
}
