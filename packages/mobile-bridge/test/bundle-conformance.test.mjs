import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  sealPassphraseBlob,
  sealSignatureBlob,
  zoneRootCommitmentHex,
  deriveAgentAddresses,
  deriveEvmAgentKey,
  deriveXrplAgentKey,
  zoneSeed,
} from '@mosaic/zone-keys';
import { encodeXrplSignIn } from '@mosaic/zone-keys/verify';
import { signXrplTransaction } from '@mosaic/xrpl';
import { signEvmTransfer } from '@mosaic/evm';
import { argon2id } from 'hash-wasm';

/**
 * Conformance of the SHIPPED bundle: dist/mosaic-bridge.js runs in a bare
 * `node:vm` context with no Node globals — the same environment shape the
 * iOS JSContext provides (host randomness injected the same way Swift does)
 * — and must reproduce the golden vectors and agree with the real
 * @mosaic/zone-keys / chain-signer outputs computed directly in Node.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundleSource = await readFile(path.join(root, 'dist', 'mosaic-bridge.js'), 'utf8');
const vectors = JSON.parse(
  await readFile(path.join(root, '..', 'zone-keys', 'vectors', 'zone-vectors.json'), 'utf8'),
);
const argonKat = JSON.parse(await readFile(path.join(root, 'vectors', 'argon2-kat.json'), 'utf8'));

function bareBridge() {
  const sandbox = {
    __mosaicRandomBytes: (length) => Array.from(randomBytes(length)),
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });
  vm.runInContext(bundleSource, context, { filename: 'mosaic-bridge.js' });
  assert.ok(sandbox.MosaicBridge, 'bundle must install globalThis.MosaicBridge');
  return { bridge: sandbox.MosaicBridge, context };
}

const { bridge } = bareBridge();
const secretHex = vectors.zoneRootSecret;
const secret = Uint8Array.from(Buffer.from(secretHex, 'hex'));

test('bundle runs without Node globals and exposes the bridge surface', () => {
  for (const name of [
    'deriveAddresses',
    'verifyCommitment',
    'openSignatureBlob',
    'openPassphraseBlob',
    'passphraseKdfParams',
    'xrplTxnSignatureBytes',
    'signXrplTransfer',
    'signStellarTransfer',
    'signEvmTransfer',
    'guardianAddress',
    'guardianSignText',
  ]) {
    assert.equal(typeof bridge[name], 'function', `missing bridge.${name}`);
  }
});

test('golden vectors: every case derives identical agent addresses', () => {
  for (const kase of vectors.cases) {
    const ref = {
      rootChain: kase.rootChain,
      rootAddress: kase.rootAddress,
      zone: kase.zone,
      network: kase.network,
    };
    for (const [index, expected] of Object.entries(kase.agents)) {
      const derived = JSON.parse(bridge.deriveAddresses(secretHex, JSON.stringify(ref), Number(index)));
      assert.deepEqual(derived, expected, `${kase.rootChain}/${kase.zone}/${kase.network}#${index}`);
      // Cross-check the oracle itself.
      assert.deepEqual(deriveAgentAddresses(secret, ref, Number(index)), expected);
    }
  }
});

test('commitment verification', () => {
  const commitment = zoneRootCommitmentHex(secret);
  assert.equal(bridge.verifyCommitment(secretHex, commitment), true);
  assert.equal(bridge.verifyCommitment(secretHex, commitment.replace(/^../, '00')), false);
});

const ref = { rootChain: 'xrpl', rootAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', zone: 'top', network: 'mainnet' };
const refJson = JSON.stringify(ref);
const commitment = zoneRootCommitmentHex(secret);

test('signature blob sealed in Node opens in the bare bridge', () => {
  const signature = Uint8Array.from(Buffer.from('aa'.repeat(71), 'hex'));
  const wrapped = sealSignatureBlob(signature, secret, ref);
  const opened = bridge.openSignatureBlob(
    Buffer.from(signature).toString('hex'),
    JSON.stringify(wrapped.header),
    Buffer.from(wrapped.ciphertext).toString('base64'),
    refJson,
    commitment,
  );
  assert.equal(opened, secretHex);

  assert.throws(() =>
    bridge.openSignatureBlob(
      Buffer.from(signature).toString('hex'),
      JSON.stringify(wrapped.header),
      Buffer.from(wrapped.ciphertext).toString('base64'),
      refJson,
      commitment.replace(/^../, '00'),
    ),
  );
});

test('passphrase blob: hash-wasm kek in Node opens in the bare bridge', async () => {
  const kat = argonKat.reduced[0];
  const salt = Uint8Array.from(Buffer.from(kat.saltHex, 'hex'));
  const kek = await argon2id({
    password: kat.passphrase,
    salt,
    iterations: kat.t,
    memorySize: kat.m,
    parallelism: kat.p,
    hashLength: 32,
    outputType: 'binary',
  });
  assert.equal(Buffer.from(kek).toString('hex'), kat.kekHex, 'argon2 KAT drifted');

  // Blob headers assert frozen V1 params, so seal with a V1-labeled header
  // but the reduced-work kek: the AEAD path is identical.
  const wrapped = sealPassphraseBlob(kek, salt, secret, ref);
  const params = JSON.parse(
    bridge.passphraseKdfParams(JSON.stringify(wrapped.header), Buffer.from(wrapped.ciphertext).toString('base64')),
  );
  assert.equal(params.saltHex, kat.saltHex);
  assert.equal(params.m, 262144);

  const opened = bridge.openPassphraseBlob(
    Buffer.from(kek).toString('hex'),
    JSON.stringify(wrapped.header),
    Buffer.from(wrapped.ciphertext).toString('base64'),
    refJson,
    commitment,
  );
  assert.equal(opened, secretHex);
});

test('xrpl TxnSignature extraction matches the encoded blob', () => {
  const signatureHex = '30440220'.concat('11'.repeat(32), '0220', '22'.repeat(32));
  const blobHex = encodeXrplSignIn({
    Flags: 2147483648,
    Sequence: 0,
    Fee: '0',
    SigningPubKey: 'ED' + 'ab'.repeat(32).toUpperCase(),
    TxnSignature: signatureHex.toUpperCase(),
    Account: ref.rootAddress,
  });
  assert.equal(bridge.xrplTxnSignatureBytes(blobHex), signatureHex.toLowerCase());
});

test('xrpl transfer signing matches direct signer output', () => {
  const index = 0;
  const addresses = deriveAgentAddresses(secret, ref, index);
  const unsigned = {
    TransactionType: 'Payment',
    Account: addresses.xrpl,
    Destination: 'rNhnPaESvxbzmkpYfpecUDGUJPGxq8krHc',
    Amount: '1000000',
    Fee: '12',
    Sequence: 7,
    Flags: 2147483648,
    LastLedgerSequence: 1000,
  };
  const viaBridge = bridge.signXrplTransfer(JSON.stringify(unsigned), secretHex, refJson, index, addresses.xrpl);
  const key = deriveXrplAgentKey(zoneSeed(secret, ref), index);
  const direct = signXrplTransaction(unsigned, key.privateKey, key.publicKey);
  assert.equal(viaBridge, direct.txBlob);

  assert.throws(
    () => bridge.signXrplTransfer(JSON.stringify(unsigned), secretHex, refJson, index, 'rWrongAddress'),
    /does not match/,
  );
});

test('evm transfer signing matches direct signer output', async () => {
  const index = 1;
  const addresses = deriveAgentAddresses(secret, ref, index);
  const unsigned = {
    from: addresses.evm,
    to: '0x000000000000000000000000000000000000dEaD',
    value: '0x2386f26fc10000',
    chainId: '0x14a34',
    gas: '0x5208',
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
    nonce: '0x0',
    type: '0x2',
  };
  const viaBridge = await bridge.signEvmTransfer(JSON.stringify(unsigned), secretHex, refJson, index, addresses.evm);
  const key = deriveEvmAgentKey(zoneSeed(secret, ref), index);
  const direct = await signEvmTransfer(unsigned, key.privateKey.slice());
  assert.equal(viaBridge, direct);
});

test('stellar transfer signing matches direct signer output', async () => {
  const index = 2;
  const addresses = deriveAgentAddresses(secret, ref, index);
  const { Account, Asset, Networks, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const { signStellarTransaction } = await import('@mosaic/stellar');
  const { deriveStellarAgentKey } = await import('@mosaic/zone-keys');
  const unsigned = new TransactionBuilder(new Account(addresses.stellar, '7'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: 'GDI6V6XSIXSV7P43UER4L7IPU63PFGQINIFP6RLWH5AMPELQBC2JMTBJ',
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(300)
    .build()
    .toEnvelope()
    .toXDR('base64');

  const viaBridge = bridge.signStellarTransfer(unsigned, 'testnet', secretHex, refJson, index, addresses.stellar);
  const key = deriveStellarAgentKey(zoneSeed(secret, ref), index);
  assert.equal(viaBridge, signStellarTransaction(unsigned, 'testnet', key.privateKey));
});

test('companion protocol: enroll and decide in the bare bridge verify in Node', async () => {
  const {
    createCompanionOffer,
    createCompanionEnvelope,
    verifyCompanionEnvelope,
    companionDigest,
  } = await import('@mosaic/local-runtime/companion');
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  const { concatBytes, utf8ToBytes } = await import('@noble/hashes/utils.js');

  // The desktop guardian authority IS the vault-derived EVM key at index 5.
  const { deriveEvmAgentKey } = await import('@mosaic/zone-keys');
  const guardianKey = deriveEvmAgentKey(zoneSeed(secret, ref), 5);
  const signDesktop = (text) => {
    const bytes = utf8ToBytes(text);
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
    const recovered = secp256k1.sign(keccak_256(concatBytes(prefix, bytes)), guardianKey.privateKey, {
      prehash: false, format: 'recovered',
    });
    return Uint8Array.from([...recovered.slice(1), recovered[0] + 27]);
  };

  const offer = createCompanionOffer(
    {
      guardianId: guardianKey.address,
      guardianControlInboxId: 'guardian-inbox',
      vault: ref.zone,
      authorityIndex: 5,
      network: ref.network,
      nonce: 'cd'.repeat(32),
    },
    signDesktop,
  );

  // Phone side (bare bridge): validate offer, enroll with the same vault.
  assert.equal(typeof bridge.companionVerifyOffer(JSON.stringify(offer)), 'string');
  const enrollment = JSON.parse(
    bridge.companionEnroll(JSON.stringify(offer), secretHex, refJson, 'phone-inbox', 'Test iPhone', 'enroll-1'),
  );
  verifyCompanionEnvelope(enrollment, guardianKey.address);
  assert.equal(enrollment.payload.pairingNonce, offer.nonce);

  // Desktop forwards; phone verifies + decides; desktop verifies decision.
  const forward = createCompanionEnvelope(
    {
      kind: 'approval-forward',
      requestId: 'req-9',
      guardianId: guardianKey.address,
      guardianControlInboxId: 'guardian-inbox',
      companionInboxId: 'phone-inbox',
      sequence: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { operation: 'transaction.propose', requestId: 'req-9', network: ref.network, summary: { chain: 'xrpl' } },
    },
    signDesktop,
  );
  assert.equal(typeof bridge.companionVerifyEnvelope(JSON.stringify(forward), guardianKey.address), 'string');
  assert.throws(() => bridge.companionVerifyEnvelope(JSON.stringify(forward), '0x' + '22'.repeat(20)));

  const decision = JSON.parse(
    bridge.companionDecide(JSON.stringify(forward), 'approve', '', secretHex, refJson, 5, 'phone-inbox', 3),
  );
  verifyCompanionEnvelope(decision, guardianKey.address);
  assert.equal(decision.payload.forwardDigest, companionDigest(forward.payload));
  assert.equal(decision.payload.decision, 'approve');
});

test('guardian identity and EIP-191 decision signature verify in Node', async () => {
  const index = 3;
  const addresses = deriveAgentAddresses(secret, ref, index);
  assert.equal(bridge.guardianAddress(secretHex, refJson, index), addresses.evm);

  const text = 'mosaic-control-v3|approval-decision|digest';
  const signatureHex = bridge.guardianSignText(secretHex, refJson, index, text);
  const { verifyMessage } = await import('viem');
  const valid = await verifyMessage({
    address: addresses.evm,
    message: text,
    signature: `0x${signatureHex}`,
  });
  assert.equal(valid, true);
});
