import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveKeypair, deriveAddress, sign as rippleSign } from 'ripple-keypairs';
import {
  backupWrapMessage,
  backupSignaturesDeterministic,
  eip712TypedData,
  stellarAddressFromPublicKey,
} from '../dist/index.js';
import {
  sep53Digest,
  stellarSigningPayload,
  xrplSignInTxJson,
  xrplSigningPayload,
  encodeXrplSignIn,
  verifyXrplSignInBlob,
} from '../dist/verify/index.js';

/**
 * Determinism regression (spec §9): backup-wrap signatures recorded at
 * freeze-time must be reproduced byte-for-byte by current library versions.
 * A diff here means a wallet-lib or message-encoding change would strand
 * every layer-1 blob in existence — do NOT update the recorded values;
 * find and fix the encoding drift instead.
 */

test('recorded EVM backup-wrap signature reproduces', async () => {
  const account = privateKeyToAccount('0x' + '11'.repeat(32));
  const message = backupWrapMessage({
    rootChain: 'evm',
    rootAddress: account.address,
    zone: 'top',
    network: 'testnet',
  });
  const signature = await account.signTypedData(eip712TypedData(message, 11155111));
  assert.equal(
    signature,
    '0x5944ac61f8f56b8026a94237a4374a502415ee2da8c9240f4669f089cee1747746a81f2718431785028aa4773187b232da5d8ac04b9f86a3406129b948ab2b851b',
  );
});

test('recorded Stellar backup-wrap signature reproduces', () => {
  const priv = new Uint8Array(32).fill(0x22);
  const address = stellarAddressFromPublicKey(ed25519.getPublicKey(priv));
  assert.equal(address, 'GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N');
  const message = backupWrapMessage({ rootChain: 'stellar', rootAddress: address, zone: 'top', network: 'testnet' });
  const signature = ed25519.sign(sep53Digest(stellarSigningPayload(message)), priv);
  assert.equal(
    bytesToHex(signature),
    'b1e2ea9aef1b5750b7d4b5764d6509d1cb1cd49f5db4defe64b612678d0f08a4a1e3194e6404635a32750a87853857a2458e7dce6568553f827bb07795bd6b05',
  );
});

test('recorded XRPL backup-wrap SignIn blob reproduces and still verifies', () => {
  const keypair = deriveKeypair('sp5fghtJtpUorTwvof1NpDXAzNwf5');
  const address = deriveAddress(keypair.publicKey);
  assert.equal(address, 'rU6K7V3Po4snVhBBaU29sesqs2qTQJWDw1');
  const message = backupWrapMessage({ rootChain: 'xrpl', rootAddress: address, zone: 'top', network: 'testnet' });
  const tx = { ...xrplSignInTxJson(message), Account: address, SigningPubKey: keypair.publicKey };
  const blob = encodeXrplSignIn({ ...tx, TxnSignature: rippleSign(xrplSigningPayload(tx), keypair.privateKey) });
  assert.equal(
    blob,
    '1203E77321030D58EB48B4420B1F7B9DF55087E0E29FEF0E8468F9A6825B01CA2C361042D43574463044022056C714C8B6048EBBCDDDB57BE04314EA182DFED29F4E5E7D1CF5EC96DD6D70110220648D97C4F52A05913B1BF9A5C86D089DDAD47653C1307FD129A6FB481C46012A81148049717CC948789F32F267ADC2582484E3DFA698F9EA7C0E6D6F736169632F7A6F6E652D76317DB37B226E6574776F726B223A22746573746E6574222C2270726F746F636F6C223A224D4F534149435F5A4F4E455F44455249564154494F4E5F5631222C22707572706F7365223A226261636B75702D77726170222C22726F6F7441646472657373223A227255364B375633506F34736E56684242615532397365737173327154514A57447731222C22726F6F74436861696E223A227872706C222C2276657273696F6E223A312C227A6F6E65223A22746F70227DE1F1',
  );
  assert.ok(verifyXrplSignInBlob(blob, { account: address, message }).valid);
});

test('backupSignaturesDeterministic: self-test gating', () => {
  const a = new Uint8Array(65).fill(1);
  const b = new Uint8Array(65).fill(1);
  assert.ok(backupSignaturesDeterministic(a, b));
  b[64] ^= 1; // hedged / non-deterministic wallet
  assert.ok(!backupSignaturesDeterministic(a, b));
  assert.ok(!backupSignaturesDeterministic(a, new Uint8Array(64).fill(1))); // length mismatch
  assert.ok(!backupSignaturesDeterministic(new Uint8Array(0), new Uint8Array(0))); // empty
});
