import MCPClient
import MosaicCore
import SwiftUI
import WalletLink

/// Vault transfers signed on-device (Face ID → networkless JS context →
/// signed blob to `transfer_submit`), plus XRPL root transfers via a Xaman
/// payload. The backend only ever sees ciphertext and signed blobs.
struct TransferView: View {
  @Environment(AppModel.self) private var model
  @State private var flow = TransferFlow()

  var body: some View {
    Form {
      Section("From") {
        Picker("Source", selection: $flow.source) {
          Text("Select…").tag(TransferFlow.Source?.none)
          ForEach(flow.sources(model: model)) { source in
            Text(source.label).tag(Optional(source))
          }
        }
      }

      if let source = flow.source {
        Section("Asset") {
          Picker("Asset", selection: $flow.assetId) {
            Text("Select…").tag(String?.none)
            ForEach(flow.assets(model: model, source: source)) { asset in
              Text(asset.symbol).tag(Optional(asset.id))
            }
          }
        }
        Section("To") {
          TextField("Destination address", text: $flow.destination)
            .font(.callout.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Amount", text: $flow.amount)
            .keyboardType(.decimalPad)
            .font(.callout.monospacedDigit())
        }
        Section {
          Button {
            flow.prepare(model: model)
          } label: {
            if case .preparing = flow.phase {
              ProgressView()
            } else {
              Text("Review transfer")
            }
          }
          .disabled(!flow.canPrepare)
        }
      }

      switch flow.phase {
      case .review(let prepared):
        Section("Review") {
          LabeledContent("Amount", value: "\(prepared.transfer.amount) \(prepared.transfer.assetSymbol ?? "")")
          if let fee = prepared.transfer.raw["fee"]?.stringValue,
             let feeSymbol = prepared.transfer.raw["feeSymbol"]?.stringValue {
            LabeledContent("Network fee", value: "\(fee) \(feeSymbol)")
          }
          LabeledContent("Destination") {
            Text(prepared.transfer.destinationAddress ?? "")
              .font(.caption.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Button {
            flow.signAndSubmit(model: model, prepared: prepared)
          } label: {
            Label("Sign & submit", systemImage: "checkmark.seal")
          }
        }
      case .xamanWaiting(let refs):
        Section {
          XamanRequestView(refs: refs, status: "Approve the transfer in Xaman…") { flow.reset() }
        }
      case .submitting:
        Section { ProgressView("Submitting…") }
      case .done(let transfer):
        Section {
          Label("Submitted — status: \(transfer.status)", systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
          if let hash = transfer.transactionHash {
            Text(hash)
              .font(.caption2.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Button("New transfer") { flow.reset() }
        }
      case .failed(let message):
        Section {
          Label(message, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
            .font(.footnote)
          Button("Try again") { flow.reset(keepInputs: true) }
        }
      case .idle, .preparing:
        EmptyView()
      }
    }
    .navigationTitle("Transfer")
    .task { await flow.loadCatalog(model: model) }
  }
}

@Observable @MainActor
final class TransferFlow {
  struct Source: Identifiable, Hashable {
    enum Kind: Hashable {
      case root
      case vault(zoneId: String, addressId: String, index: Int, name: String)
    }

    let kind: Kind
    let chain: AgentChain
    let address: String
    let zone: String?

    var id: String { "\(chain.rawValue)|\(address)|\(zone ?? "root")" }
    var label: String {
      switch kind {
      case .root: return "Root wallet (\(chain.rawValue.uppercased()))"
      case .vault(_, _, _, let name): return "\(zone ?? "")/\(name) (\(chain.rawValue.uppercased()))"
      }
    }
  }

  struct AssetChoice: Identifiable, Hashable {
    let id: String
    let symbol: String
  }

  enum Phase {
    case idle
    case preparing
    case review(TransferPrepared)
    case xamanWaiting(XamanRefs)
    case submitting
    case done(ActivityItem)
    case failed(String)
  }

  var source: Source?
  var assetId: String?
  var destination = ""
  var amount = ""
  var phase: Phase = .idle
  private var catalog: [CatalogAsset] = []
  private var task: Task<Void, Never>?

  var canPrepare: Bool {
    if case .preparing = phase { return false }
    return source != nil && assetId != nil && !destination.isEmpty && !amount.isEmpty
  }

  func loadCatalog(model: AppModel) async {
    guard let auth = model.auth, catalog.isEmpty else { return }
    catalog = (try? await model.api.catalogAssets(token: auth.token)) ?? []
  }

  func sources(model: AppModel) -> [Source] {
    guard let auth = model.auth else { return [] }
    var list: [Source] = []
    if auth.chain == .xrpl {
      // Root transfers sign via a Xaman payload; EVM/Stellar roots need
      // WalletConnect and are not offered here yet.
      list.append(Source(kind: .root, chain: .xrpl, address: auth.address, zone: nil))
    }
    for zone in model.zones {
      guard let unlockedZone = model.vault.unlocked[zone.zoneId] else { continue }
      for entry in unlockedZone.addresses {
        guard let address = entry.address else { continue }
        list.append(
          Source(
            kind: .vault(zoneId: zone.zoneId, addressId: entry.id, index: entry.index, name: entry.name),
            chain: entry.chain,
            address: address,
            zone: zone.zone
          )
        )
      }
    }
    return list
  }

  func assets(model: AppModel, source: Source) -> [AssetChoice] {
    guard let auth = model.auth else { return [] }
    let chainId = source.chain == .evm
      ? (auth.network == .mainnet ? "base-mainnet" : "base-sepolia")
      : "\(source.chain.rawValue)-\(auth.network.rawValue)"
    return catalog.compactMap { asset in
      guard asset.trustState == "allowed", let deployment = asset.deployment(chainId: chainId) else { return nil }
      return AssetChoice(id: asset.id, symbol: deployment.symbol)
    }
  }

  func prepare(model: AppModel) {
    guard let auth = model.auth, let source, let assetId else { return }
    run {
      self.phase = .preparing
      let sourceArg: (kind: String, address: String, zone: String?, addressId: String?, name: String?)
      switch source.kind {
      case .root:
        sourceArg = ("root", source.address, nil, nil, nil)
      case .vault(_, let addressId, _, let name):
        sourceArg = ("vault", source.address, source.zone, addressId, name)
      }
      let prepared = try await model.api.transferPrepare(
        token: auth.token,
        chain: source.chain,
        source: sourceArg,
        destination: self.destination.trimmingCharacters(in: .whitespaces),
        assetId: assetId,
        amount: self.amount
      )
      self.phase = .review(prepared)
    }
  }

  func signAndSubmit(model: AppModel, prepared: TransferPrepared) {
    guard let auth = model.auth, let source else { return }
    run {
      let transferId = prepared.transfer.id
      switch prepared.signingRequest {
      case .xaman(let refs):
        self.phase = .xamanWaiting(refs)
        let outcome = try await XamanLink(refs: refs).waitForResolution()
        guard case .signed = outcome else {
          self.phase = .failed(outcome == .rejected ? "Declined in Xaman." : "The Xaman request expired.")
          return
        }
        self.phase = .submitting
        let transfer = try await model.api.transferSubmit(
          token: auth.token, transferId: transferId, signed: .xaman(payloadUuid: refs.uuid)
        )
        self.phase = .done(transfer)

      case .xrpl(let unsignedJson):
        try await self.submitVaultSigned(model: model, auth: auth, source: source, transferId: transferId) {
          vault, ref, index, secretHex in
          .xrpl(txBlob: try await vault.engine.signXrplTransfer(
            unsignedTxJson: unsignedJson, secretHex: secretHex, ref: ref, index: index, expectedAddress: source.address
          ))
        }

      case .stellar(let unsignedXdr, _):
        try await self.submitVaultSigned(model: model, auth: auth, source: source, transferId: transferId) {
          vault, ref, index, secretHex in
          .stellar(signedXdr: try await vault.engine.signStellarTransfer(
            unsignedXdr: unsignedXdr, network: auth.network, secretHex: secretHex,
            ref: ref, index: index, expectedAddress: source.address
          ))
        }

      case .evm(let txJson):
        try await self.submitVaultSigned(model: model, auth: auth, source: source, transferId: transferId) {
          vault, ref, index, secretHex in
          .evmRaw(serializedTransaction: try await vault.engine.signEvmTransfer(
            txJson: txJson, secretHex: secretHex, ref: ref, index: index, expectedAddress: source.address
          ))
        }
      }
      await model.refreshActivity()
    }
  }

  private func submitVaultSigned(
    model: AppModel,
    auth: AuthVerifyResult,
    source: Source,
    transferId: String,
    sign: @escaping (VaultStore, ZoneRef, Int, String) async throws -> MosaicAPI.TransferSigned
  ) async throws {
    guard case .vault(let zoneId, _, let index, _) = source.kind,
          let unlockedZone = model.vault.unlocked[zoneId]
    else {
      phase = .failed("Unlock the zone before signing.")
      return
    }
    phase = .submitting
    let signed = try await model.vault.withSecret(
      ref: unlockedZone.ref,
      reason: "Sign transfer from \(source.label)"
    ) { secretHex in
      try await sign(model.vault, unlockedZone.ref, index, secretHex)
    }
    let transfer = try await model.api.transferSubmit(token: auth.token, transferId: transferId, signed: signed)
    phase = .done(transfer)
  }

  func reset(keepInputs: Bool = false) {
    task?.cancel()
    phase = .idle
    if !keepInputs {
      destination = ""
      amount = ""
    }
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
