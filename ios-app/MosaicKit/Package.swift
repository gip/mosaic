// swift-tools-version:5.10
import PackageDescription

// All app logic lives here; the Xcode app target is a thin SwiftUI shell.
// macOS is listed only so `swift test` runs without a simulator; the app
// itself is iOS 17+.
let package = Package(
  name: "MosaicKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(
      name: "MosaicKit",
      targets: ["MosaicCore", "MCPClient", "WalletLink", "ChainFeeds", "VaultKeychain"]
    ),
  ],
  targets: [
    .target(name: "MosaicCore"),
    .target(name: "MCPClient", dependencies: ["MosaicCore"]),
    .target(name: "WalletLink", dependencies: ["MosaicCore", "MCPClient"]),
    .target(name: "ChainFeeds", dependencies: ["MosaicCore"]),
    .target(name: "VaultKeychain"),
    .testTarget(
      name: "MosaicKitTests",
      dependencies: ["MosaicCore", "MCPClient", "WalletLink", "ChainFeeds"]
    ),
  ]
)
