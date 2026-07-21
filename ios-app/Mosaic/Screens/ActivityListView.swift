import MosaicCore
import SwiftUI

struct ActivityListView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    List {
      if model.activity.isEmpty {
        ContentUnavailableView(
          "No activity",
          systemImage: "clock",
          description: Text("Orders and transfers made with this root wallet will appear here.")
        )
      }
      ForEach(model.activity) { item in
        ActivityRow(item: item)
      }
    }
    .navigationTitle("Activity")
    .refreshable { await model.refreshActivity() }
    .task { await model.refreshActivity() }
  }
}

struct ActivityRow: View {
  let item: ActivityItem

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Label(title, systemImage: icon)
          .font(.subheadline.weight(.medium))
        Spacer()
        StatusBadge(status: item.status)
      }
      Text(subtitle)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Text("\(item.chain.uppercased()) · \(Formatting.timestamp(item.createdAt))")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
    .padding(.vertical, 2)
  }

  private var title: String {
    switch item.kind {
    case .transfer:
      return "Transfer \(item.amount) \(item.assetSymbol ?? "")"
    case .order:
      let side = (item.side ?? "").capitalized
      return "\(side) \(item.amount) \(item.baseSymbol ?? "")"
    case .unknown:
      return "Activity"
    }
  }

  private var subtitle: String {
    switch item.kind {
    case .transfer:
      let destination = item.destinationAddress ?? "?"
      return "to \(destination)"
    case .order:
      if let price = item.limitPrice, let quote = item.quoteSymbol {
        return "limit \(price) \(quote)"
      }
      return item.addressName ?? item.sourceAddress
    case .unknown:
      return item.sourceAddress
    }
  }

  private var icon: String {
    switch item.kind {
    case .transfer: return "arrow.up.right"
    case .order: return "chart.line.uptrend.xyaxis"
    case .unknown: return "questionmark.circle"
    }
  }
}

struct StatusBadge: View {
  let status: String

  var body: some View {
    Text(status.replacingOccurrences(of: "_", with: " "))
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(color.opacity(0.15), in: Capsule())
      .foregroundStyle(color)
  }

  private var color: Color {
    switch status {
    case "confirmed", "filled": return .green
    case "failed", "expired", "canceled": return .red
    case "awaiting_signature": return .orange
    default: return .blue
    }
  }
}
