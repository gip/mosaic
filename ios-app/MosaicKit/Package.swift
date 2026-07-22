// swift-tools-version:5.10
import PackageDescription

// All app logic lives here; the Xcode app target is a thin SwiftUI shell.
// macOS is listed only so `swift test` runs without a simulator (including
// the real-JavaScriptCore golden-vector conformance tests); the app itself
// is iOS 17+.
let package = Package(
  name: "MosaicKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(
      name: "MosaicKit",
      targets: ["MosaicCore", "MCPClient", "WalletLink", "ChainFeeds", "VaultKeychain", "ZoneCryptoJS", "GuardianKit"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
    .package(url: "https://github.com/xmtp/xmtp-ios.git", from: "4.0.0"),
    .package(url: "https://github.com/WalletConnect/WalletConnectSwiftV2.git", from: "1.19.0"),
  ],
  targets: [
    .target(name: "MosaicCore"),
    .target(name: "MCPClient", dependencies: ["MosaicCore"]),
    .target(
      name: "WalletLink",
      dependencies: [
        "MosaicCore", "MCPClient", "ZoneCryptoJS",
        .product(name: "WalletConnect", package: "WalletConnectSwiftV2", condition: .when(platforms: [.iOS])),
        .product(name: "WalletConnectNetworking", package: "WalletConnectSwiftV2", condition: .when(platforms: [.iOS])),
        .product(name: "WalletConnectPairing", package: "WalletConnectSwiftV2", condition: .when(platforms: [.iOS])),
      ]
    ),
    .target(name: "ChainFeeds", dependencies: ["MosaicCore"]),
    .target(name: "VaultKeychain"),
    .target(
      name: "ZoneCryptoJS",
      dependencies: [
        "MosaicCore",
        .product(name: "Sodium", package: "swift-sodium"),
      ],
      resources: [.copy("Resources/mosaic-bridge.js"), .copy("Resources/mosaic-bridge.sha256")]
    ),
    .target(
      name: "GuardianKit",
      dependencies: [
        "MosaicCore", "MCPClient", "ZoneCryptoJS", "VaultKeychain",
        .product(name: "XMTPiOS", package: "xmtp-ios"),
      ]
    ),
    .testTarget(
      name: "MosaicKitTests",
      dependencies: ["MosaicCore", "MCPClient", "WalletLink", "ChainFeeds", "ZoneCryptoJS", "GuardianKit"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
