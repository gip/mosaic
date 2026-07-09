import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveKeypair, deriveAddress, generateSeed, sign as rippleSign } from 'ripple-keypairs';
import {
  authorizeZoneMessage,
  backupWrapMessage,
  sessionAuthMessage,
  eip712TypedData,
  stellarAddressFromPublicKey,
  canonicalJson,
} from '../dist/index.js';
import {
  recoverEvmZoneSigner,
  verifyEvmZoneSignature,
  sep53Digest,
  stellarSigningPayload,
  verifyStellarZoneSignature,
  xrplSignInTxJson,
  verifyXrplSignInBlob,
  xrplTxnSignatureBytes,
  encodeXrplSignIn,
  xrplSigningPayload,
} from '../dist/verify/index.js';

const evmAccount = privateKeyToAccount('0x' + '11'.repeat(32));
const stellarPriv = new Uint8Array(32).fill(0x22);
const stellarPub = ed25519.getPublicKey(stellarPriv);
const stellarAddress = stellarAddressFromPublicKey(stellarPub);
// Deterministic XRPL secp256k1 keypair from a fixed family seed.
const xrplKeypair = deriveKeypair('sp5fghtJtpUorTwvof1NpDXAzNwf5'); // well-known test seed
const xrplAddress = deriveAddress(xrplKeypair.publicKey);

const nonceFields = {
  nonce: 'test-nonce-1',
  issuedAt: '2026-07-08T00:00:00.000Z',
  expiresAt: '2026-07-08T00:05:00.000Z',
};

function refFor(chain, address) {
  return { rootChain: chain, rootAddress: address, zone: 'top', network: 'testnet' };
}

// ---------- EVM ----------

test('evm: EIP-712 sign/recover round-trip for all three purposes', async () => {
  const ref = refFor('evm', evmAccount.address);
  const messages = [
    authorizeZoneMessage(ref, {
      localSignerPublicKey: 'browser-host-key',
      policyHash: 'ph',
      zoneRootCommitment: 'zc',
      ...nonceFields,
    }),
    backupWrapMessage(ref),
    sessionAuthMessage({ rootChain: 'evm', rootAddress: evmAccount.address, network: 'testnet', ...nonceFields }),
  ];
  for (const message of messages) {
    const typed = eip712TypedData(message, 11155111);
    const signature = await evmAccount.signTypedData(typed);
    assert.ok(await verifyEvmZoneSignature(message, 11155111, signature, evmAccount.address), message.purpose);
    const recovered = await recoverEvmZoneSigner(message, 11155111, signature);
    assert.equal(recovered.toLowerCase(), evmAccount.address.toLowerCase());
  }
});

test('evm: tampered field / wrong chainId / purpose swap rejected', async () => {
  const ref = refFor('evm', evmAccount.address);
  const message = backupWrapMessage(ref);
  const signature = await evmAccount.signTypedData(eip712TypedData(message, 1));
  assert.ok(await verifyEvmZoneSignature(message, 1, signature, evmAccount.address));
  // tampered zone
  assert.ok(!(await verifyEvmZoneSignature(backupWrapMessage({ ...ref, zone: 'agents' }), 1, signature, evmAccount.address)));
  // wrong domain chainId
  assert.ok(!(await verifyEvmZoneSignature(message, 11155111, signature, evmAccount.address)));
  // purpose confusion: a backup-wrap signature must not verify as session-auth
  const session = sessionAuthMessage({ rootChain: 'evm', rootAddress: evmAccount.address, network: 'testnet', ...nonceFields });
  assert.ok(!(await verifyEvmZoneSignature(session, 1, signature, evmAccount.address)));
});

test('evm: EIP-712 signatures are deterministic (RFC 6979) — self-test basis', async () => {
  const message = backupWrapMessage(refFor('evm', evmAccount.address));
  const typed = eip712TypedData(message, 1);
  const sig1 = await evmAccount.signTypedData(typed);
  const sig2 = await evmAccount.signTypedData(typed);
  assert.equal(sig1, sig2);
});

// ---------- Stellar ----------

test('stellar: SEP-53 sign/verify round-trip; wrong address and tamper rejected', () => {
  const ref = refFor('stellar', stellarAddress);
  const message = backupWrapMessage(ref);
  const signature = ed25519.sign(sep53Digest(stellarSigningPayload(message)), stellarPriv);
  assert.ok(verifyStellarZoneSignature(message, signature, stellarAddress));
  // tampered message
  assert.ok(!verifyStellarZoneSignature(backupWrapMessage({ ...ref, network: 'mainnet' }), signature, stellarAddress));
  // wrong signer
  const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x33));
  assert.ok(!verifyStellarZoneSignature(message, signature, stellarAddressFromPublicKey(otherPub)));
  // garbage address
  assert.ok(!verifyStellarZoneSignature(message, signature, 'GNOTANADDRESS'));
});

test('stellar: ed25519 signatures deterministic — self-test basis', () => {
  const message = backupWrapMessage(refFor('stellar', stellarAddress));
  const digest = sep53Digest(stellarSigningPayload(message));
  assert.deepEqual(ed25519.sign(digest, stellarPriv), ed25519.sign(digest, stellarPriv));
});

// ---------- XRPL ----------

function signedSignInBlob(message, keypair, account, { stripType = false } = {}) {
  const { TransactionType, ...rest } = xrplSignInTxJson(message);
  const tx = {
    ...(stripType ? rest : { TransactionType, ...rest }),
    Account: account,
    SigningPubKey: keypair.publicKey,
  };
  const signature = rippleSign(xrplSigningPayload(tx), keypair.privateKey);
  return encodeXrplSignIn({ ...tx, TxnSignature: signature });
}

test('xrpl: SignIn blob verify round-trip with memo binding', () => {
  const ref = refFor('xrpl', xrplAddress);
  const message = backupWrapMessage(ref);
  const blob = signedSignInBlob(message, xrplKeypair, xrplAddress);
  const result = verifyXrplSignInBlob(blob, { account: xrplAddress, message });
  assert.ok(result.valid, result.error);
  assert.equal(result.account, xrplAddress);
  assert.equal(result.signerAddress, xrplAddress); // master key signed
  assert.equal(result.memoJson, canonicalJson(message));
});

test('xrpl: blob without TransactionType verifies (real Xaman shape)', () => {
  // Xaman strips the SignIn pseudo-type before signing: real blobs carry
  // Flags/Sequence/Fee/SigningPubKey/TxnSignature/Account/Memos only.
  const ref = refFor('xrpl', xrplAddress);
  const message = backupWrapMessage(ref);
  const blob = signedSignInBlob(message, xrplKeypair, xrplAddress, { stripType: true });
  const result = verifyXrplSignInBlob(blob, { account: xrplAddress, message });
  assert.ok(result.valid, result.error);
  assert.equal(result.account, xrplAddress);
  assert.equal(result.memoJson, canonicalJson(message));
});

test('xrpl: real Xaman SignIn blob accepted (XRPL-Labs verify-xrpl-signature fixture)', () => {
  // Fixture from XRPL-Labs/verify-xrpl-signature test/fixtures.json ("valid"):
  // a genuine Xaman SignIn signature — no TransactionType field in the blob.
  const blob =
    '2280000000240000000268400000000000000C73210333C718C9CB716E0575454F4A343D46B284ED51151B' +
    '9C7383524B82C10B262095744730450221009A4D99017F8FD6881D888047E2F9F90C068C09EC9308BC8526' +
    '116B539D6DD44102207FAA7E8756F67FE7EE1A88884F120A00A8EC37E7D3E5ED3E02FEA7B1D97AA0558114' +
    '6C0994D3FCB140CAB36BAE9465137448883FA487';
  const result = verifyXrplSignInBlob(blob);
  assert.ok(result.valid, result.error);
  assert.equal(result.account, 'rwiETSee2wMz3SBnAG8hkMsCgvGy9LWbZ1');
  assert.equal(result.signerAddress, result.account);
});

test('xrpl: blob with a real transaction type rejected', () => {
  const ref = refFor('xrpl', xrplAddress);
  const message = backupWrapMessage(ref);
  const { TransactionType, ...rest } = xrplSignInTxJson(message);
  const tx = {
    ...rest,
    TransactionType: 'AccountSet',
    Account: xrplAddress,
    SigningPubKey: xrplKeypair.publicKey,
    Fee: '0',
    Sequence: 0,
  };
  const blob = encodeXrplSignIn({ ...tx, TxnSignature: rippleSign(xrplSigningPayload(tx), xrplKeypair.privateKey) });
  const result = verifyXrplSignInBlob(blob, { account: xrplAddress, message });
  assert.ok(!result.valid);
  assert.match(result.error, /not a SignIn transaction/);
});

test('xrpl: wrong account / wrong message / tampered blob rejected', () => {
  const ref = refFor('xrpl', xrplAddress);
  const message = backupWrapMessage(ref);
  const blob = signedSignInBlob(message, xrplKeypair, xrplAddress);
  assert.ok(!verifyXrplSignInBlob(blob, { account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }).valid);
  assert.ok(!verifyXrplSignInBlob(blob, { message: backupWrapMessage({ ...ref, zone: 'agents' }) }).valid);
  // flip a byte inside the blob (memo area, keeps structure decodable or fails — both are rejections)
  const tampered = blob.slice(0, blob.length - 8) + 'DEADBEEF';
  assert.ok(!verifyXrplSignInBlob(tampered, { account: xrplAddress }).valid);
});

test('xrpl: signature from a different key rejected; signerAddress reported for non-master signer', () => {
  const ref = refFor('xrpl', xrplAddress);
  const message = backupWrapMessage(ref);
  const otherKeypair = deriveKeypair(
    generateSeed({ entropy: new Uint8Array(16).fill(9), algorithm: 'ecdsa-secp256k1' }),
  );
  // signed by other key but claiming xrplAddress as Account (regular-key-style)
  const blob = signedSignInBlob(message, otherKeypair, xrplAddress);
  const result = verifyXrplSignInBlob(blob, { account: xrplAddress, message });
  assert.ok(result.valid); // crypto-valid…
  assert.notEqual(result.signerAddress, result.account); // …but signer ≠ account: ledger check must decide
});

test('xrpl: TxnSignature bytes extraction is stable', () => {
  const message = backupWrapMessage(refFor('xrpl', xrplAddress));
  const blob = signedSignInBlob(message, xrplKeypair, xrplAddress);
  const bytes1 = xrplTxnSignatureBytes(blob);
  const bytes2 = xrplTxnSignatureBytes(blob);
  assert.deepEqual(bytes1, bytes2);
  assert.ok(bytes1.length > 60); // DER-encoded secp256k1
});

test('xrpl: signing is deterministic — self-test basis', () => {
  const message = backupWrapMessage(refFor('xrpl', xrplAddress));
  const blob1 = signedSignInBlob(message, xrplKeypair, xrplAddress);
  const blob2 = signedSignInBlob(message, xrplKeypair, xrplAddress);
  assert.equal(blob1, blob2);
});
