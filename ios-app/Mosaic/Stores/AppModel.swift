import ChainFeeds
import Foundation
import MCPClient
import MosaicCore
import Observation
import VaultKeychain

/// Root observable state for the app: MCP session lifecycle plus the
/// read-only monitor data (zones, balances, activity). Phase A holds no key
/// material — the only secret is the bearer session token, kept in the
/// Keychain.
@Observable @MainActor
final class AppModel {
  enum SessionState {
    case idle
    case authenticating
    case active(AuthVerifyResult)
  }

  let api: MosaicAPI
  let vault = VaultStore()
  let companion = CompanionStore()
  private let tokenItem = KeychainItem(account: "mcp-session-token")
  private static let sessionDefaultsKey = "mosaic.session"

  var session: SessionState = .idle
  var zones: [ZoneListItem] = []
  var activity: [ActivityItem] = []
  var lastError: String?
  var zonesLoading = false

  /// Per address `chain|address|network`, refreshed by the detail screens.
  var balances: [String: AccountBalances] = [:]

  init() {
    self.api = MosaicAPI(url: AppConfig.mcpURL)
    restoreSession()
  }

  var auth: AuthVerifyResult? {
    if case .active(let auth) = session { return auth }
    return nil
  }

  // MARK: Session persistence

  private struct StoredSession: Codable {
    let chain: RootChain
    let address: String
    let network: Network
    let expiresAt: Double
  }

  private func restoreSession() {
    guard
      let data = UserDefaults.standard.data(forKey: Self.sessionDefaultsKey),
      let stored = try? JSONDecoder().decode(StoredSession.self, from: data),
      stored.expiresAt > Date().timeIntervalSince1970 * 1000,
      let tokenData = try? tokenItem.read(),
      let token = String(data: tokenData, encoding: .utf8)
    else { return }
    session = .active(
      AuthVerifyResult(
        token: token,
        chain: stored.chain,
        address: stored.address,
        network: stored.network,
        expiresAt: stored.expiresAt
      )
    )
    Task { await refreshAll() }
  }

  func adopt(session auth: AuthVerifyResult) {
    session = .active(auth)
    lastError = nil
    try? tokenItem.write(Data(auth.token.utf8))
    let stored = StoredSession(chain: auth.chain, address: auth.address, network: auth.network, expiresAt: auth.expiresAt)
    UserDefaults.standard.set(try? JSONEncoder().encode(stored), forKey: Self.sessionDefaultsKey)
    Task { await refreshAll() }
  }

  func logout() async {
    if let auth {
      try? await api.authLogout(token: auth.token)
    }
    clearLocalSession()
  }

  func clearLocalSession() {
    session = .idle
    zones = []
    activity = []
    balances = [:]
    vault.lockAll()
    try? tokenItem.delete()
    UserDefaults.standard.removeObject(forKey: Self.sessionDefaultsKey)
  }

  func switchNetwork(_ network: Network) async {
    guard let auth, auth.network != network else { return }
    do {
      adopt(session: try await api.authNetworkSwitch(token: auth.token, network: network))
    } catch {
      report(error)
    }
  }

  // MARK: Monitor data

  func refreshAll() async {
    async let zonesTask: Void = refreshZones()
    async let activityTask: Void = refreshActivity()
    _ = await (zonesTask, activityTask)
  }

  func refreshZones() async {
    guard let auth else { return }
    zonesLoading = true
    defer { zonesLoading = false }
    do {
      zones = try await api.zoneList(token: auth.token)
      lastError = nil
    } catch {
      report(error)
    }
  }

  func refreshActivity() async {
    guard let auth else { return }
    do {
      activity = try await api.activityList(token: auth.token)
    } catch {
      report(error)
    }
  }

  func refreshBalances(for zone: ZoneListItem) async {
    guard let auth else { return }
    await withTaskGroup(of: (String, AccountBalances)?.self) { group in
      for item in zone.addresses {
        guard let address = item.address else { continue }
        let network = auth.network
        group.addTask {
          let result = try? await BalancesFetcher.fetch(chain: item.chain, network: network, address: address)
          return result.map { ("\(item.chain.rawValue)|\(address)|\(network.rawValue)", $0) }
        }
      }
      for await entry in group {
        if let (key, snapshot) = entry { balances[key] = snapshot }
      }
    }
  }

  func balances(for item: ZoneAddressItem) -> AccountBalances? {
    guard let auth, let address = item.address else { return nil }
    return balances["\(item.chain.rawValue)|\(address)|\(auth.network.rawValue)"]
  }

  // MARK: Errors

  private func report(_ error: Error) {
    // An invalidated session (expiry, server restart) drops back to login.
    if let mcpError = error as? MCPError, mcpError.toolCode == "AUTH_EXPIRED" {
      clearLocalSession()
      return
    }
    lastError = error.localizedDescription
  }
}
