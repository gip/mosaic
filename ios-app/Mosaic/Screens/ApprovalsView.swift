import GuardianKit
import MosaicCore
import SwiftUI
import VisionKit

/// Approvals inbox: pending agent-start and transaction requests forwarded by
/// the desktop Guardian. Every decision is Face ID + a signature by the
/// vault-derived guardian authority key.
struct ApprovalsView: View {
  @Environment(AppModel.self) private var model
  @State private var showingPairing = false

  var body: some View {
    List {
      if let pairing = model.companion.pairing {
        Section {
          LabeledContent("Desktop Guardian") {
            Text(pairing.guardianId)
              .font(.caption.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
          }
          LabeledContent("Vault", value: pairing.vault)
          LabeledContent("Transport") {
            switch model.companion.transportState {
            case .listening:
              Label("Listening", systemImage: "dot.radiowaves.left.and.right")
                .font(.caption)
                .foregroundStyle(.green)
            case .connecting:
              Label("Connecting…", systemImage: "hourglass")
                .font(.caption)
                .foregroundStyle(.secondary)
            case .failed(let message):
              Label(message, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
            case .idle:
              Label("Idle", systemImage: "pause.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          Button("Unpair", role: .destructive) { model.companion.unpair() }
        } header: {
          Text("Companion")
        }

        Section("Requests") {
          if model.companion.approvals.isEmpty {
            Text("No approval requests yet. They appear here the moment the desktop Guardian receives one.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          ForEach(model.companion.approvals) { request in
            ApprovalRow(request: request)
          }
        }
      } else {
        Section {
          ContentUnavailableView {
            Label("Not paired", systemImage: "iphone.gen3.radiowaves.left.and.right")
          } description: {
            Text("Pair this phone with your desktop Guardian to approve agent actions from anywhere. In the desktop app choose “Add companion device”, then scan the QR code.")
          } actions: {
            Button("Pair with desktop Guardian") { showingPairing = true }
              .buttonStyle(.borderedProminent)
          }
        }
      }
    }
    .navigationTitle("Approvals")
    .sheet(isPresented: $showingPairing) {
      PairingSheet()
    }
    .task {
      await model.companion.start(model: model)
    }
  }
}

struct ApprovalRow: View {
  @Environment(AppModel.self) private var model
  let request: ApprovalRequest
  @State private var confirming: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Label(title, systemImage: request.operation == "agent-start" ? "play.circle" : "signature")
          .font(.subheadline.weight(.medium))
        Spacer()
        StatusBadge(status: request.status.rawValue)
      }
      if let agentId = request.agentId {
        Text("Agent: \(agentId)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      ForEach(request.summary.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
        HStack {
          Text(key)
            .font(.caption2)
            .foregroundStyle(.tertiary)
          Spacer()
          Text(value)
            .font(.caption2.monospaced())
            .lineLimit(1)
        }
      }
      if let detail = request.detail {
        Text(detail)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      if request.status == .pending {
        HStack(spacing: 12) {
          Button("Approve") { confirming = "approve" }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
          Button("Reject", role: .destructive) { confirming = "reject" }
            .buttonStyle(.bordered)
            .controlSize(.small)
          if request.agentId != nil && request.operation != "agent-start" {
            Button("Revoke agent", role: .destructive) { confirming = "revoke" }
              .buttonStyle(.bordered)
              .controlSize(.small)
          }
        }
        .padding(.top, 4)
      }
    }
    .padding(.vertical, 4)
    .confirmationDialog(
      "Confirm \(confirming ?? "")",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible
    ) {
      Button(confirming?.capitalized ?? "", role: confirming == "approve" ? nil : .destructive) {
        if let decision = confirming {
          Task { await model.companion.decide(request, decision: decision, reason: "", model: model) }
        }
        confirming = nil
      }
    } message: {
      Text("Face ID will confirm this decision; it is signed with your zone's guardian key.")
    }
  }

  private var title: String {
    request.operation == "agent-start" ? "Start agent" : "Agent transaction"
  }
}

/// Pairing input: live QR scan when the device supports it, plus paste.
struct PairingSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var pastedOffer = ""
  @State private var scanning = false

  var body: some View {
    NavigationStack {
      Form {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
          Section {
            Button {
              scanning = true
            } label: {
              Label("Scan the desktop QR code", systemImage: "qrcode.viewfinder")
            }
          }
        }
        Section {
          TextField("Paste the companion offer JSON", text: $pastedOffer, axis: .vertical)
            .font(.caption.monospaced())
            .lineLimit(6, reservesSpace: true)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
          Button("Pair") {
            submit(pastedOffer)
          }
          .disabled(pastedOffer.isEmpty)
        } footer: {
          Text("Pairing signs an enrollment with your zone's guardian key (Face ID) — the desktop accepts companions only from the same unlocked vault.")
        }
        if let error = model.companion.lastError {
          Section {
            Label(error, systemImage: "exclamationmark.triangle")
              .font(.footnote)
              .foregroundStyle(.red)
          }
        }
      }
      .navigationTitle("Pair companion")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .sheet(isPresented: $scanning) {
        QRScannerView { payload in
          scanning = false
          submit(payload)
        }
      }
    }
  }

  private func submit(_ offerJson: String) {
    Task {
      await model.companion.pair(offerJson: offerJson.trimmingCharacters(in: .whitespacesAndNewlines), model: model)
      if model.companion.pairing != nil { dismiss() }
    }
  }
}

/// VisionKit-based QR scanner (iOS 16+; unavailable in the simulator).
struct QRScannerView: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      isHighlightingEnabled: true
    )
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let onCode: (String) -> Void

    init(onCode: @escaping (String) -> Void) {
      self.onCode = onCode
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in addedItems {
        if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
          onCode(payload)
          return
        }
      }
    }
  }
}
