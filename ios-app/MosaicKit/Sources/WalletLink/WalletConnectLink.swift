import Combine
import Foundation
import MosaicCore
#if canImport(WalletConnectSign)
import WalletConnectNetworking
import WalletConnectPairing
import WalletConnectRelay
import WalletConnectSign
import WalletConnectUtils
#endif

/// WalletConnect v2 root-wallet connectivity (EVM via MetaMask mobile,
/// Stellar via WC-capable wallets like Lobstr), mirroring
/// packages/web-connector's connectors. The phone deeplinks the pairing URI
/// into the wallet app; signing requests round-trip over the WC relay.
///
/// The reown SDK's binary dependencies are iOS-only, so the implementation is
/// conditionally compiled; on macOS (unit tests) every entry point throws
/// `notConfigured`.
public enum WalletConnectLink {
  public enum WCError: Error, LocalizedError {
    case notConfigured
    case unsupportedPlatform
    case noAccount
    case badResponse(String)

    public var errorDescription: String? {
      switch self {
      case .notConfigured: return "Set a WalletConnect project id in Settings first."
      case .unsupportedPlatform: return "WalletConnect is available on iOS only."
      case .noAccount: return "The wallet approved the session without an account — enable the requested network in the wallet and retry."
      case .badResponse(let detail): return detail
      }
    }
  }

  public struct SessionInfo: Sendable {
    public let topic: String
    public let chainId: String
    public let address: String

    public init(topic: String, chainId: String, address: String) {
      self.topic = topic
      self.chainId = chainId
      self.address = address
    }
  }

  // Chain ids mirror web-connector: eip155 Base, stellar pubnet/testnet.
  public static func evmChainId(network: Network) -> String {
    network == .mainnet ? "eip155:8453" : "eip155:84532"
  }

  public static func stellarChainId(network: Network) -> String {
    network == .mainnet ? "stellar:pubnet" : "stellar:testnet"
  }

  /// MetaMask universal link for a pairing URI (pins the scan to MetaMask).
  public static func metamaskLink(uri: String) -> URL? {
    URL(string: "https://metamask.app.link/wc?uri=\(uri.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? uri)")
  }

  /// Freighter mobile deeplink for a pairing URI.
  public static func freighterLink(uri: String) -> URL? {
    URL(string: "freighterwallet://wc-redirect/wc?uri=\(uri.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? uri)")
  }

  #if canImport(WalletConnectSign)
  private static var configuredProjectId: String?

  /// One-time relay configuration. Safe to call repeatedly with the same id.
  public static func configure(projectId: String) {
    guard !projectId.isEmpty, configuredProjectId != projectId else { return }
    Networking.configure(
      groupIdentifier: "group.xyz.edfi.mosaic",
      projectId: projectId,
      socketFactory: URLSessionSocketFactory()
    )
    guard let redirect = try? AppMetadata.Redirect(native: "mosaic://", universal: nil) else { return }
    Pair.configure(metadata: AppMetadata(
      name: "Mosaic",
      description: "Mosaic zone-derived agent wallets",
      url: "https://mosaic.edfi.xyz",
      icons: [],
      redirect: redirect
    ))
    configuredProjectId = projectId
  }

  public static var isConfigured: Bool { configuredProjectId != nil }

  /// Propose a session and wait for the wallet to settle it.
  public static func connect(
    chainId: String,
    methods: [String],
    onPairingURI: @escaping (String) -> Void
  ) async throws -> SessionInfo {
    guard isConfigured else { throw WCError.notConfigured }
    guard let blockchain = Blockchain(chainId) else { throw WCError.badResponse("bad chain id \(chainId)") }
    let namespaces: [String: ProposalNamespace] = [
      blockchain.namespace: ProposalNamespace(chains: [blockchain], methods: Set(methods), events: []),
    ]
    let uri = try await Sign.instance.connect(requiredNamespaces: namespaces)
    onPairingURI(uri.absoluteString)

    var cancellable: AnyCancellable?
    defer { cancellable?.cancel() }
    let session: Session = try await withCheckedThrowingContinuation { continuation in
      var resumed = false
      cancellable = Sign.instance.sessionSettlePublisher.sink { settled in
        guard !resumed else { return }
        resumed = true
        continuation.resume(returning: settled)
      }
    }

    let account = session.namespaces.values
      .flatMap(\.accounts)
      .first { $0.blockchain.absoluteString == chainId }
    guard let account else { throw WCError.noAccount }
    return SessionInfo(topic: session.topic, chainId: chainId, address: account.address)
  }

  /// One JSON-RPC request over the session; returns the raw JSON response.
  public static func request(
    session: SessionInfo,
    method: String,
    paramsJson: String
  ) async throws -> JSONValue {
    guard let blockchain = Blockchain(session.chainId) else { throw WCError.badResponse("bad chain id") }
    let params = try JSONDecoder().decode(AnyCodable.self, from: Data(paramsJson.utf8))
    let request = try Request(topic: session.topic, method: method, params: params, chainId: blockchain)
    try await Sign.instance.request(params: request)

    var cancellable: AnyCancellable?
    defer { cancellable?.cancel() }
    let response: Response = try await withCheckedThrowingContinuation { continuation in
      var resumed = false
      cancellable = Sign.instance.sessionResponsePublisher.sink { response in
        guard response.topic == session.topic, !resumed else { return }
        resumed = true
        continuation.resume(returning: response)
      }
    }

    switch response.result {
    case .response(let value):
      let data = try JSONEncoder().encode(value)
      return try JSONDecoder().decode(JSONValue.self, from: data)
    case .error(let error):
      throw WCError.badResponse(error.message)
    }
  }

  public static func disconnect(session: SessionInfo) async {
    try? await Sign.instance.disconnect(topic: session.topic)
  }

  #else

  public static func configure(projectId: String) {}
  public static var isConfigured: Bool { false }

  public static func connect(
    chainId: String, methods: [String], onPairingURI: @escaping (String) -> Void
  ) async throws -> SessionInfo {
    throw WCError.unsupportedPlatform
  }

  public static func request(session: SessionInfo, method: String, paramsJson: String) async throws -> JSONValue {
    throw WCError.unsupportedPlatform
  }

  public static func disconnect(session: SessionInfo) async {}

  #endif
}

#if canImport(WalletConnectSign)

// MARK: - URLSession-backed WebSocket for the WC relay

final class URLSessionSocketFactory: WebSocketFactory {
  func create(with url: URL) -> WebSocketConnecting {
    URLSessionWebSocket(url: url)
  }
}

final class URLSessionWebSocket: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate, @unchecked Sendable {
  var isConnected = false
  var onConnect: (() -> Void)?
  var onDisconnect: ((Error?) -> Void)?
  var onText: ((String) -> Void)?
  var request: URLRequest

  private var task: URLSessionWebSocketTask?
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

  init(url: URL) {
    self.request = URLRequest(url: url)
    super.init()
  }

  func connect() {
    let task = session.webSocketTask(with: request)
    self.task = task
    task.resume()
    receiveLoop(task)
  }

  func disconnect() {
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    isConnected = false
  }

  func write(string: String, completion: (() -> Void)?) {
    task?.send(.string(string)) { _ in completion?() }
  }

  private func receiveLoop(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, self.task === task else { return }
      switch result {
      case .success(.string(let text)):
        self.onText?(text)
        self.receiveLoop(task)
      case .success:
        self.receiveLoop(task)
      case .failure(let error):
        self.isConnected = false
        self.onDisconnect?(error)
      }
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocolName: String?) {
    isConnected = true
    onConnect?()
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    isConnected = false
    onDisconnect?(nil)
  }
}

#endif
