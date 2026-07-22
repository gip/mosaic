import ChainFeeds
import MosaicCore
import SwiftUI

struct ZoneDetailView: View {
  @Environment(AppModel.self) private var model
  let zone: ZoneListItem

  @State private var showingUnlock = false

  private var isUnlocked: Bool { model.vault.isUnlocked(zoneId: zone.zoneId) }

  /// Prefer locally derived addresses (post-unlock) over server records.
  private var addressEntries: [ZoneAddressItem] {
    model.vault.unlocked[zone.zoneId]?.addresses ?? zone.addresses
  }

  var body: some View {
    List {
      Section("Zone") {
        LabeledContent("Mode") { ZoneModeBadge(mode: zone.mode) }
        LabeledContent("Status") {
          Label(
            isUnlocked ? "Unlocked" : "Locked",
            systemImage: isUnlocked ? "lock.open.fill" : "lock.fill"
          )
          .font(.caption.weight(.semibold))
          .foregroundStyle(isUnlocked ? .green : .secondary)
        }
        if let unlocked = zone.lastUnlockedAt {
          LabeledContent("Last unlocked", value: Formatting.timestamp(unlocked))
        }
        LabeledContent("Created", value: Formatting.timestamp(zone.createdAt))
        if isUnlocked {
          Button("Lock zone") { model.vault.lock(zoneId: zone.zoneId) }
          if let auth = model.auth {
            Button("Forget cached secret", role: .destructive) {
              model.vault.forget(zone: zone, auth: auth)
            }
          }
        } else {
          Button {
            showingUnlock = true
          } label: {
            Label("Unlock", systemImage: "faceid")
          }
        }
      }

      ForEach(RootChain.allCases) { chain in
        let addresses = addressEntries.filter { $0.chain == chain }
        if !addresses.isEmpty {
          Section(chain.displayName) {
            ForEach(addresses) { item in
              AddressRow(item: item, balances: model.balances(for: item))
            }
          }
        }
      }

      Section("Recent activity") {
        let related = model.activity.filter { $0.zone == zone.zone }
        if related.isEmpty {
          Text("No activity for this zone yet.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        ForEach(related.prefix(20)) { item in
          ActivityRow(item: item)
        }
      }
    }
    .navigationTitle(zone.zone)
    .refreshable {
      await model.refreshBalances(for: zone)
      await model.refreshActivity()
    }
    .task {
      await model.refreshBalances(for: zone)
    }
    .sheet(isPresented: $showingUnlock) {
      UnlockSheet(zone: zone)
    }
  }
}

struct AddressRow: View {
  let item: ZoneAddressItem
  let balances: AccountBalances?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(item.name)
          .font(.subheadline.weight(.medium))
        Spacer()
        if let address = item.address {
          Button {
            UIPasteboard.general.string = address
          } label: {
            Image(systemName: "doc.on.doc")
              .font(.caption)
          }
          .buttonStyle(.borderless)
        }
      }
      if let address = item.address {
        Text(address)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if let balances {
        if balances.funded {
          ForEach(balances.balances) { entry in
            HStack {
              Text(entry.symbol)
                .font(.caption.weight(.semibold))
              Spacer()
              Text(entry.amount)
                .font(.caption.monospacedDigit())
            }
          }
        } else {
          Text("Not funded on-ledger")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      }
    }
    .padding(.vertical, 2)
  }
}

enum Formatting {
  static func timestamp(_ iso: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return iso }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
