import XCTest
@testable import MCPClient
@testable import MosaicCore

/// Live-server smoke tests, skipped unless MOSAIC_MCP_URL is set (e.g.
///   MOSAIC_MCP_URL=http://127.0.0.1:8788/mcp swift test
/// against a locally running @mosaic/mcp).
final class MCPIntegrationTests: XCTestCase {
  private func serverURL() throws -> URL {
    guard let raw = ProcessInfo.processInfo.environment["MOSAIC_MCP_URL"],
          let url = URL(string: raw)
    else { throw XCTSkip("MOSAIC_MCP_URL not set") }
    return url
  }

  func testInitializeAndAuthChallenge() async throws {
    let api = MosaicAPI(url: try serverURL())
    let challenge = try await api.authChallenge(
      chain: .evm,
      network: .testnet,
      address: "0x000000000000000000000000000000000000dEaD"
    )
    XCTAssertFalse(challenge.challengeId.isEmpty)
    XCTAssertNotNil(challenge.evmChainId)
    XCTAssertEqual(challenge.message["purpose"]?.stringValue, "session-auth")
  }

  func testToolErrorSurfaces() async throws {
    let connection = MCPConnection(url: try serverURL())
    do {
      _ = try await connection.callTool("zone_list", arguments: ["token": "not-a-real-token"])
      XCTFail("expected an auth error")
    } catch let error as MCPError {
      // Must be a server-side rejection, not a transport/parsing failure.
      if case .transport(let message) = error {
        XCTFail("transport error instead of tool error: \(message)")
      }
    }
  }
}
