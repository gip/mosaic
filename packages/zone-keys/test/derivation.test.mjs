import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { HDKey } from '@scure/bip32';
import {
  canonicalJson,
  zoneRootCommitmentHex,
  verifyCommitment,
  zoneSeed,
  slip10MasterFromSeed,
  slip10DerivePath,
  deriveAgentAddresses,
  deriveEvmAgentKey,
  deriveXrplAgentKey,
  deriveStellarAgentKey,
  evmAddressFromPrivateKey,
  toEip55,
  xrplAddressFromPublicKey,
  stellarAddressFromPublicKey,
  stellarPublicKeyFromAddress,
} from '../dist/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('../vectors/zone-vectors.json', import.meta.url), 'utf8'),
);

test('canonical JSON: sorted keys, no whitespace', () => {
  assert.equal(
    canonicalJson({ zone: 'top', protocol: 'X', nonce: 'n', version: 1 }),
    '{"nonce":"n","protocol":"X","version":1,"zone":"top"}',
  );
});

test('SLIP-0010 ed25519 official test vector 1', () => {
  const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const m = slip10MasterFromSeed(seed);
  assert.equal(bytesToHex(m.key), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(bytesToHex(m.chainCode), '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
  const deep = slip10DerivePath(seed, "m/0'/1'/2'/2'/1000000000'");
  assert.equal(bytesToHex(deep.key), '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793');
});

test('SLIP-0010 rejects non-hardened segments', () => {
  const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
  assert.throws(() => slip10DerivePath(seed, "m/44'/148'/0"), /hardened/);
});

test('Stellar derivation matches SEP-0005 test vector 1 (cross-checked with stellar-sdk)', () => {
  const seed = hexToBytes(
    'e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497e' +
      'e4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186',
  );
  const node = slip10DerivePath(seed, "m/44'/148'/0'");
  const address = stellarAddressFromPublicKey(ed25519.getPublicKey(node.key));
  assert.equal(address, 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6');
});

test('EVM derivation matches BIP44 reference (abandon…about seed)', () => {
  const seed = hexToBytes(
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
      '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  );
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  assert.equal(evmAddressFromPrivateKey(node.privateKey), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test('XRPL address encoding matches genesis account', () => {
  const pub = hexToBytes('0330e7fc9d56bb25d6893ba3f317ae5bcf33b3291bd63db32654a313222f7fd020');
  assert.equal(xrplAddressFromPublicKey(pub), 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
});

test('EIP-55 checksum vectors', () => {
  assert.equal(
    toEip55('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'),
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  );
  assert.equal(
    toEip55('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  );
});

test('strkey round-trips', () => {
  const pub = ed25519.getPublicKey(new Uint8Array(32).fill(7));
  const address = stellarAddressFromPublicKey(pub);
  assert.equal(address, 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'); // stellar-sdk cross-check
  assert.deepEqual(stellarPublicKeyFromAddress(address), pub);
});

test('golden zone vectors are frozen (release-blocking)', () => {
  const secret = hexToBytes(vectors.zoneRootSecret);
  for (const c of vectors.cases) {
    const ref = { rootChain: c.rootChain, rootAddress: c.rootAddress, zone: c.zone, network: c.network };
    assert.equal(bytesToHex(zoneSeed(secret, ref)), c.seed, `seed ${c.rootChain}/${c.zone}/${c.network}`);
    for (const [index, expected] of Object.entries(c.agents)) {
      assert.deepEqual(
        deriveAgentAddresses(secret, ref, Number(index)),
        expected,
        `addresses ${c.rootChain}/${c.zone}/${c.network}/${index}`,
      );
    }
  }
});

test('zone separation: zone, network, rootAddress, index all bind the derivation', () => {
  const secret = hexToBytes(vectors.zoneRootSecret);
  const base = { rootChain: 'xrpl', rootAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', zone: 'top', network: 'mainnet' };
  const baseSeed = bytesToHex(zoneSeed(secret, base));
  assert.notEqual(bytesToHex(zoneSeed(secret, { ...base, zone: 'agents' })), baseSeed);
  assert.notEqual(bytesToHex(zoneSeed(secret, { ...base, network: 'testnet' })), baseSeed);
  assert.notEqual(bytesToHex(zoneSeed(secret, { ...base, rootAddress: 'rDifferent' })), baseSeed);

  const a0 = deriveAgentAddresses(secret, base, 0);
  const a1 = deriveAgentAddresses(secret, base, 1);
  assert.notEqual(a0.evm, a1.evm);
  assert.notEqual(a0.xrpl, a1.xrpl);
  assert.notEqual(a0.stellar, a1.stellar);

  const otherSecret = new Uint8Array(32).fill(0xaa);
  assert.notEqual(bytesToHex(zoneSeed(otherSecret, base)), baseSeed);
});

test('XRPL agent keys are pinned to secp256k1', () => {
  const secret = hexToBytes(vectors.zoneRootSecret);
  const seed = zoneSeed(secret, vectors.cases[0]);
  const key = deriveXrplAgentKey(seed, 0);
  assert.equal(key.publicKey.length, 33); // compressed secp256k1, not 32-byte ed25519
  assert.ok(key.address.startsWith('r'));
});

test('chain keys at the same index are unrelated', () => {
  const secret = hexToBytes(vectors.zoneRootSecret);
  const seed = zoneSeed(secret, vectors.cases[0]);
  const evm = deriveEvmAgentKey(seed, 0);
  const xrpl = deriveXrplAgentKey(seed, 0);
  const stellar = deriveStellarAgentKey(seed, 0);
  assert.notEqual(bytesToHex(evm.privateKey), bytesToHex(xrpl.privateKey));
  assert.notEqual(bytesToHex(evm.privateKey), bytesToHex(stellar.privateKey));
});

test('commitment: SHA256 of secret, verified before derivation', () => {
  const secret = hexToBytes(vectors.zoneRootSecret);
  const commitment = zoneRootCommitmentHex(secret);
  assert.equal(commitment.length, 64);
  assert.ok(verifyCommitment(secret, commitment));
  assert.ok(verifyCommitment(secret, commitment.toUpperCase()));
  assert.ok(!verifyCommitment(new Uint8Array(32).fill(1), commitment));
});
