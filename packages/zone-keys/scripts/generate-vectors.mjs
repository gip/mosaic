// Generates the frozen golden vectors in vectors/zone-vectors.json.
// Run ONCE per protocol version. Never regenerate for an existing version:
// a diff in these vectors means every existing zone re-keys — the test suite
// failing against them is the point.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { zoneSeed, deriveAgentAddresses } from '../dist/index.js';

const zoneRootSecret = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const roots = [
  { rootChain: 'xrpl', rootAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
  { rootChain: 'evm', rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' },
  { rootChain: 'stellar', rootAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6' },
];

const cases = [];
for (const root of roots) {
  for (const zone of ['top', 'agents']) {
    for (const network of ['mainnet', 'testnet']) {
      const ref = { ...root, zone, network };
      const seed = zoneSeed(zoneRootSecret, ref);
      const entry = { ...ref, seed: bytesToHex(seed), agents: {} };
      for (const index of [0, 1, 2]) {
        entry.agents[index] = deriveAgentAddresses(zoneRootSecret, ref, index);
      }
      cases.push(entry);
    }
  }
}

const out = {
  protocol: 'MOSAIC_ZONE_DERIVATION_V1',
  zoneRootSecret: bytesToHex(zoneRootSecret),
  frozen: true,
  cases,
};
const path = fileURLToPath(new URL('../vectors/zone-vectors.json', import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${cases.length} cases to ${path}`);
