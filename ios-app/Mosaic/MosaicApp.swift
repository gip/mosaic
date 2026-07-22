import MosaicCore
import SwiftUI
import UserNotifications

@main
struct MosaicApp: App {
  @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .onAppear {
          pushDelegate.onDeviceToken = { [weak model] tokenHex in
            guard let model else { return }
            Task { await model.companion.registerDevice(apnsTokenHex: tokenHex, model: model) }
          }
        }
    }
  }
}

/// Registers for APNs once a session exists; forwards the hex device token
/// to the MCP device registry. Pushes are content-free wake-ups only.
final class PushDelegate: NSObject, UIApplicationDelegate {
  var onDeviceToken: ((String) -> Void)?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
      guard granted else { return }
      DispatchQueue.main.async {
        application.registerForRemoteNotifications()
      }
    }
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    onDeviceToken?(deviceToken.map { String(format: "%02x", $0) }.joined())
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    // Simulator or notification-denied environments: approvals still arrive
    // over XMTP whenever the app is foregrounded.
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    switch model.session {
    case .active:
      MainTabView()
    case .idle, .authenticating:
      LoginView()
    }
  }
}

struct MainTabView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    TabView {
      NavigationStack {
        ZoneListView()
      }
      .tabItem { Label("Zones", systemImage: "shield.lefthalf.filled") }

      NavigationStack {
        TransferView()
      }
      .tabItem { Label("Transfer", systemImage: "arrow.up.arrow.down.circle") }

      NavigationStack {
        ApprovalsView()
      }
      .tabItem { Label("Approvals", systemImage: "checkmark.shield") }

      NavigationStack {
        ActivityListView()
      }
      .tabItem { Label("Activity", systemImage: "clock.arrow.circlepath") }

      NavigationStack {
        SettingsView()
      }
      .tabItem { Label("Settings", systemImage: "gearshape") }
    }
  }
}
