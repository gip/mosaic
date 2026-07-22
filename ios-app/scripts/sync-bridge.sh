#!/bin/sh
# Rebuild @mosaic/mobile-bridge and copy the bundle into MosaicKit's
# resources. The committed copy must always match the committed TS sources;
# CI re-runs this and fails on drift.
set -eu
cd "$(dirname "$0")/../.."
pnpm --filter @mosaic/mobile-bridge bundle
cp packages/mobile-bridge/dist/mosaic-bridge.js ios-app/MosaicKit/Sources/ZoneCryptoJS/Resources/mosaic-bridge.js
cp packages/mobile-bridge/dist/mosaic-bridge.sha256 ios-app/MosaicKit/Sources/ZoneCryptoJS/Resources/mosaic-bridge.sha256
node packages/mobile-bridge/scripts/generate-swift-fixtures.mjs
cp packages/zone-keys/vectors/zone-vectors.json ios-app/MosaicKit/Tests/MosaicKitTests/Fixtures/zone-vectors.json
cp packages/mobile-bridge/vectors/argon2-kat.json ios-app/MosaicKit/Tests/MosaicKitTests/Fixtures/argon2-kat.json
cp packages/mobile-bridge/vectors/swift-fixtures.json ios-app/MosaicKit/Tests/MosaicKitTests/Fixtures/swift-fixtures.json
echo "synced $(cat packages/mobile-bridge/dist/mosaic-bridge.sha256)"
