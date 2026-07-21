import Foundation
import MosaicCore

/// One asset position on one account. `amount` is a decimal string.
public struct BalanceEntry: Sendable, Equatable, Identifiable {
  public let symbol: String
  public let issuer: String?
  public let amount: String

  public var id: String { issuer.map { "\(symbol)|\($0)" } ?? symbol }

  public init(symbol: String, issuer: String?, amount: String) {
    self.symbol = symbol
    self.issuer = issuer
    self.amount = amount
  }
}

public struct AccountBalances: Sendable, Equatable {
  public let chain: AgentChain
  public let network: Network
  public let address: String
  /// False when the account does not exist on-ledger yet (XRPL/Stellar
  /// reserve model). EVM accounts always exist.
  public let funded: Bool
  public let balances: [BalanceEntry]
  public let fetchedAt: Date
}

/// Native polled balances for the monitor screens — the Swift counterpart of
/// the chain packages' `createBalancesFeed`, deliberately scoped to what the
/// account itself reports (XRPL trust lines, Stellar account balances, EVM
/// native). Endpoints match the defaults in packages/mosaic-*/src.
public enum BalancesFetcher {
  public static let xrplEndpoints: [Network: URL] = [
    .mainnet: URL(string: "https://xrplcluster.com")!,
    .testnet: URL(string: "https://s.altnet.rippletest.net:51234")!,
  ]
  public static let horizonEndpoints: [Network: URL] = [
    .mainnet: URL(string: "https://horizon.stellar.org")!,
    .testnet: URL(string: "https://horizon-testnet.stellar.org")!,
  ]
  public static let evmEndpoints: [Network: URL] = [
    .mainnet: URL(string: "https://mainnet.base.org")!,
    .testnet: URL(string: "https://sepolia.base.org")!,
  ]

  public static func fetch(
    chain: AgentChain,
    network: Network,
    address: String,
    session: URLSession = .shared
  ) async throws -> AccountBalances {
    switch chain {
    case .xrpl: return try await fetchXrpl(network: network, address: address, session: session)
    case .stellar: return try await fetchStellar(network: network, address: address, session: session)
    case .evm: return try await fetchEvm(network: network, address: address, session: session)
    }
  }

  // MARK: XRPL

  static func fetchXrpl(network: Network, address: String, session: URLSession) async throws -> AccountBalances {
    let endpoint = xrplEndpoints[network]!
    let info = try await postJSON(
      endpoint,
      body: [
        "method": "account_info",
        "params": [["account": .string(address), "ledger_index": "validated"]],
      ],
      session: session
    )
    let result = info["result"]
    if result?["error"]?.stringValue == "actNotFound" {
      return AccountBalances(chain: .xrpl, network: network, address: address, funded: false, balances: [], fetchedAt: Date())
    }
    guard let drops = result?["account_data"]?["Balance"]?.stringValue,
          let xrp = DecimalString.scaleDown(drops, decimals: 6)
    else { throw FeedError.transport("unexpected account_info response") }
    var entries = [BalanceEntry(symbol: "XRP", issuer: nil, amount: xrp)]

    let lines = try await postJSON(
      endpoint,
      body: [
        "method": "account_lines",
        "params": [["account": .string(address), "ledger_index": "validated"]],
      ],
      session: session
    )
    for line in lines["result"]?["lines"]?.arrayValue ?? [] {
      guard
        let currency = line["currency"]?.stringValue,
        let issuer = line["account"]?.stringValue,
        let balance = line["balance"]?.stringValue
      else { continue }
      entries.append(BalanceEntry(symbol: decodeXrplCurrency(currency), issuer: issuer, amount: balance))
    }
    return AccountBalances(chain: .xrpl, network: network, address: address, funded: true, balances: entries, fetchedAt: Date())
  }

  /// 40-char hex currency codes decode to their ASCII name when printable.
  static func decodeXrplCurrency(_ code: String) -> String {
    guard code.count == 40, code.allSatisfy(\.isHexDigit) else { return code }
    var bytes: [UInt8] = []
    var index = code.startIndex
    while index < code.endIndex {
      let next = code.index(index, offsetBy: 2)
      guard let byte = UInt8(code[index..<next], radix: 16) else { return code }
      if byte != 0 { bytes.append(byte) }
      index = next
    }
    guard !bytes.isEmpty, bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) else { return code }
    return String(decoding: bytes, as: UTF8.self)
  }

  // MARK: Stellar

  static func fetchStellar(network: Network, address: String, session: URLSession) async throws -> AccountBalances {
    let url = horizonEndpoints[network]!.appending(path: "accounts/\(address)")
    var request = URLRequest(url: url)
    request.setValue("application/json", forHTTPHeaderField: "accept")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw FeedError.transport("non-HTTP response") }
    if http.statusCode == 404 {
      return AccountBalances(chain: .stellar, network: network, address: address, funded: false, balances: [], fetchedAt: Date())
    }
    guard http.statusCode == 200 else { throw FeedError.transport("Horizon HTTP \(http.statusCode)") }
    let json = try JSONDecoder().decode(JSONValue.self, from: data)
    var entries: [BalanceEntry] = []
    for balance in json["balances"]?.arrayValue ?? [] {
      guard let amount = balance["balance"]?.stringValue,
            let type = balance["asset_type"]?.stringValue
      else { continue }
      if type == "native" {
        entries.append(BalanceEntry(symbol: "XLM", issuer: nil, amount: amount))
      } else if let code = balance["asset_code"]?.stringValue,
                let issuer = balance["asset_issuer"]?.stringValue {
        entries.append(BalanceEntry(symbol: code, issuer: issuer, amount: amount))
      }
    }
    // Horizon lists native last; the UI expects it first like the other chains.
    entries.sort { $0.issuer == nil && $1.issuer != nil }
    return AccountBalances(chain: .stellar, network: network, address: address, funded: true, balances: entries, fetchedAt: Date())
  }

  // MARK: EVM (Base)

  static func fetchEvm(network: Network, address: String, session: URLSession) async throws -> AccountBalances {
    let json = try await postJSON(
      evmEndpoints[network]!,
      body: [
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [.string(address), "latest"],
      ],
      session: session
    )
    guard
      let hex = json["result"]?.stringValue,
      let wei = DecimalString.fromHexQuantity(hex),
      let eth = DecimalString.scaleDown(wei, decimals: 18)
    else { throw FeedError.transport("unexpected eth_getBalance response") }
    return AccountBalances(
      chain: .evm,
      network: network,
      address: address,
      funded: true,
      balances: [BalanceEntry(symbol: "ETH", issuer: nil, amount: eth)],
      fetchedAt: Date()
    )
  }

  private static func postJSON(_ url: URL, body: JSONValue, session: URLSession) async throws -> JSONValue {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw FeedError.transport("RPC HTTP error from \(url.host ?? "endpoint")")
    }
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }
}

/// Local error type so ChainFeeds stays independent of MCPClient.
public enum FeedError: Error, LocalizedError {
  case transport(String)
  public var errorDescription: String? {
    if case .transport(let message) = self { return message }
    return nil
  }
}
