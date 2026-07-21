import MosaicCore
import SwiftUI

struct ZoneListView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    List {
      if let error = model.lastError {
        Section {
          Label(error, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.orange)
        }
      }
      if model.zones.isEmpty && !model.zonesLoading {
        ContentUnavailableView(
          "No zones yet",
          systemImage: "shield.slash",
          description: Text("Create a zone from the web or desktop app; it will appear here.")
        )
      }
      ForEach(model.zones) { zone in
        NavigationLink(value: zone.zoneId) {
          ZoneRow(zone: zone)
        }
      }
    }
    .navigationTitle("Zones")
    .navigationDestination(for: String.self) { zoneId in
      if let zone = model.zones.first(where: { $0.zoneId == zoneId }) {
        ZoneDetailView(zone: zone)
      }
    }
    .refreshable { await model.refreshZones() }
    .task { await model.refreshZones() }
    .overlay {
      if model.zonesLoading && model.zones.isEmpty { ProgressView() }
    }
  }
}

struct ZoneRow: View {
  let zone: ZoneListItem

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(zone.zone)
          .font(.headline)
        Spacer()
        ZoneModeBadge(mode: zone.mode)
      }
      Text("\(zone.addresses.count) agent address\(zone.addresses.count == 1 ? "" : "es")")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 2)
  }
}

struct ZoneModeBadge: View {
  let mode: ZoneMode

  var body: some View {
    Text(label)
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(color.opacity(0.15), in: Capsule())
      .foregroundStyle(color)
  }

  private var label: String {
    switch mode {
    case .signed: return "PROTECTED"
    case .testnetDevice: return "TESTNET"
    case .testnetServer: return "TESTNET · SERVER"
    }
  }

  private var color: Color {
    mode == .signed ? .green : .orange
  }
}
