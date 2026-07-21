import XCTest
@testable import ChainFeeds
@testable import MCPClient
@testable import MosaicCore

final class SSEParserTests: XCTestCase {
  func testSingleEvent() {
    var parser = SSEParser()
    XCTAssertNil(parser.consume(line: "event: message"))
    XCTAssertNil(parser.consume(line: "data: {\"a\":1}"))
    XCTAssertEqual(parser.consume(line: ""), "{\"a\":1}")
  }

  func testMultiLineDataAndComments() {
    var parser = SSEParser()
    XCTAssertNil(parser.consume(line: ": keepalive"))
    XCTAssertNil(parser.consume(line: "data: first"))
    XCTAssertNil(parser.consume(line: "data:second"))
    XCTAssertEqual(parser.consume(line: ""), "first\nsecond")
    // Blank line with no pending data is not an event.
    XCTAssertNil(parser.consume(line: ""))
  }
}

final class JSONValueTests: XCTestCase {
  func testRoundTripAndAccessors() throws {
    let text = #"{"a":[1,true,"x"],"b":{"c":null},"n":9007199254740991}"#
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    XCTAssertEqual(value["a"]?[1]?.boolValue, true)
    XCTAssertEqual(value["a"]?[2]?.stringValue, "x")
    XCTAssertEqual(value["b"]?["c"], .null)
    // Integral numbers re-encode without a decimal point.
    let encoded = String(decoding: try JSONEncoder().encode(value["n"]!), as: UTF8.self)
    XCTAssertEqual(encoded, "9007199254740991")
  }
}

final class ModelDecodingTests: XCTestCase {
  func testAuthVerifyResult() throws {
    let text = #"{"token":"t1","chain":"xrpl","address":"rXYZ","network":"testnet","expiresAt":1750000000000}"#
    let result = try JSONDecoder().decode(AuthVerifyResult.self, from: Data(text.utf8))
    XCTAssertEqual(result.chain, .xrpl)
    XCTAssertEqual(result.network, .testnet)
  }

  func testZoneListItem() throws {
    let text = #"""
    {"zoneId":"z1","zone":"main","commitment":"c","mode":"signed","createdAt":"2026-01-01T00:00:00Z",
     "addresses":[{"id":"a1","zoneId":"z1","chain":"evm","index":0,"name":"agent-1","address":"0xabc","createdAt":"2026-01-01T00:00:00Z"}],
     "chains":[{"chainId":"base-mainnet","chainKey":"base","name":"Base","family":"evm","network":"mainnet","evmChainId":8453,"enabled":true}]}
    """#
    let zone = try JSONDecoder().decode(ZoneListItem.self, from: Data(text.utf8))
    XCTAssertEqual(zone.mode, .signed)
    XCTAssertEqual(zone.addresses.first?.chain, .evm)
    XCTAssertEqual(zone.chains.first?.evmChainId, 8453)
  }

  func testActivityItemVariants() throws {
    let transfer = try JSONDecoder().decode(
      JSONValue.self,
      from: Data(#"{"id":"t1","kind":"transfer","chain":"xrpl","network":"testnet","status":"confirmed","sourceAddress":"r1","sourceKind":"vault","amount":"5","assetSymbol":"XRP","destinationAddress":"r2","createdAt":"x","updatedAt":"y"}"#.utf8)
    )
    let item = ActivityItem(json: transfer)
    XCTAssertEqual(item.kind, .transfer)
    XCTAssertEqual(item.assetSymbol, "XRP")

    let order = try JSONDecoder().decode(
      JSONValue.self,
      from: Data(#"{"id":"o1","chain":"stellar","network":"mainnet","status":"open","sourceAddress":"G1","sourceKind":"root","side":"buy","amount":"10","baseSymbol":"XLM","quoteSymbol":"USDC","limitPrice":"0.1","createdAt":"x","updatedAt":"y"}"#.utf8)
    )
    XCTAssertEqual(ActivityItem(json: order).kind, .order)
  }
}

final class DecimalStringTests: XCTestCase {
  func testHexQuantityBeyondUInt64() {
    // 20 ETH in wei: 20 * 10^18 > UInt64.max.
    XCTAssertEqual(DecimalString.fromHexQuantity("0x1158e460913d00000"), "20000000000000000000")
    XCTAssertEqual(DecimalString.fromHexQuantity("0x0"), "0")
    XCTAssertNil(DecimalString.fromHexQuantity("0xzz"))
  }

  func testScaleDown() {
    XCTAssertEqual(DecimalString.scaleDown("1234567", decimals: 6), "1.234567")
    XCTAssertEqual(DecimalString.scaleDown("1000000", decimals: 6), "1")
    XCTAssertEqual(DecimalString.scaleDown("1", decimals: 6), "0.000001")
    XCTAssertEqual(DecimalString.scaleDown("20000000000000000000", decimals: 18), "20")
    XCTAssertEqual(DecimalString.scaleDown("0", decimals: 6), "0")
  }

  func testXrplCurrencyDecoding() {
    XCTAssertEqual(BalancesFetcher.decodeXrplCurrency("USD"), "USD")
    // "SOLO" padded to 160 bits.
    XCTAssertEqual(
      BalancesFetcher.decodeXrplCurrency("534F4C4F00000000000000000000000000000000"),
      "SOLO"
    )
  }
}
