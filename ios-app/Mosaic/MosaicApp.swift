import MosaicCore
import SwiftUI

@main
struct MosaicApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
    }
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
