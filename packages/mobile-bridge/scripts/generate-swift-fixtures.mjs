import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  deriveAgentAddresses,
  deriveEvmAgentKey,
  deriveStellarAgentKey,
  deriveXrplAgentKey,
  sealPassphraseBlob,
  sealSignatureBlob,
  zoneRootCommitmentHex,
  zoneSeed,
} from '@mosaic/zone-keys';
import { encodeXrplSignIn } from '@mosaic/zone-keys/verify';
import { signXrplTransaction } from '@mosaic/xrpl';
import { signStellarTransaction } from '@mosaic/stellar';
import { signEvmTransfer } from '@mosaic/evm';
import { Account, Asset, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { companionOfferSignatureText, createCompanionEnvelope } from '@mosaic/local-runtime/companion';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * On-device parity fixtures for the Swift XCTest suite: blobs sealed and
 * transactions signed here in Node must open/sign byte-identically inside
 * the real JavaScriptCore. All signing is deterministic (RFC 6979 / Ed25519),
 * so expected outputs are exact.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vectors = JSON.parse(await readFile(path.join(root, '..', 'zone-keys', 'vectors', 'zone-vectors.json'), 'utf8'));
const argonKat = JSON.parse(await readFile(path.join(root, 'vectors', 'argon2-kat.json'), 'utf8'));

const secretHex = vectors.zoneRootSecret;
const secret = Uint8Array.from(Buffer.from(secretHex, 'hex'));
const ref = { rootChain: 'xrpl', rootAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', zone: 'top', network: 'mainnet' };
const commitment = zoneRootCommitmentHex(secret);
const seed = zoneSeed(secret, ref);
const addresses0 = deriveAgentAddresses(secret, ref, 0);

const signatureHex = 'ab'.repeat(71);
const sigBlob = sealSignatureBlob(Uint8Array.from(Buffer.from(signatureHex, 'hex')), secret, ref);

const kat = argonKat.reduced[0];
const passBlob = sealPassphraseBlob(
  Uint8Array.from(Buffer.from(kat.kekHex, 'hex')),
  Uint8Array.from(Buffer.from(kat.saltHex, 'hex')),
  secret,
  ref,
);

const txnSignatureHex = '30440220'.concat('11'.repeat(32), '0220', '22'.repeat(32));
const signInBlobHex = encodeXrplSignIn({
  Flags: 2147483648,
  Sequence: 0,
  Fee: '0',
  SigningPubKey: 'ED' + 'ab'.repeat(32).toUpperCase(),
  TxnSignature: txnSignatureHex.toUpperCase(),
  Account: ref.rootAddress,
});

const xrplUnsigned = {
  TransactionType: 'Payment',
  Account: addresses0.xrpl,
  Destination: 'rNhnPaESvxbzmkpYfpecUDGUJPGxq8krHc',
  Amount: '1000000',
  Fee: '12',
  Sequence: 7,
  Flags: 2147483648,
  LastLedgerSequence: 1000,
};
const xrplKey = deriveXrplAgentKey(seed, 0);
const xrplSigned = signXrplTransaction(xrplUnsigned, xrplKey.privateKey, xrplKey.publicKey);

const stellarUnsigned = new TransactionBuilder(new Account(addresses0.stellar, '7'), {
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
const stellarKey = deriveStellarAgentKey(seed, 0);
const stellarSigned = signStellarTransaction(stellarUnsigned, 'testnet', stellarKey.privateKey);

const evmUnsigned = {
  from: addresses0.evm,
  to: '0x000000000000000000000000000000000000dEaD',
  value: '0x2386f26fc10000',
  chainId: '0x14a34',
  gas: '0x5208',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x3b9aca00',
  nonce: '0x0',
  type: '0x2',
};
const evmKey = deriveEvmAgentKey(seed, 0);
const evmSigned = await signEvmTransfer(evmUnsigned, evmKey.privateKey.slice());

// Companion fixtures: the desktop guardian authority is the vault-derived
// EVM key at index 5; offers and forwards are desktop-signed.
const guardianKey = deriveEvmAgentKey(seed, 5);
const signDesktop = (text) => {
  const bytes = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const recovered = secp256k1.sign(keccak_256(concatBytes(prefix, bytes)), guardianKey.privateKey, {
    prehash: false, format: 'recovered',
  });
  return Uint8Array.from([...recovered.slice(1), recovered[0] + 27]);
};
// Offers live 5 minutes, so a committed fixture is necessarily EXPIRED by
// test time — the XCTest asserts the bridge rejects it (freshness rule);
// live-offer verification runs in the Node vm conformance test.
const expiredIssued = Date.now() - 10 * 60_000;
const expiredOffer = {
  protocol: 'MOSAIC_AGENT_CONTROL_V3',
  kind: 'companion-offer',
  guardianId: guardianKey.address,
  guardianControlInboxId: 'guardian-inbox',
  vault: ref.zone,
  authorityIndex: 5,
  network: ref.network,
  nonce: 'ef'.repeat(32),
  issuedAt: new Date(expiredIssued).toISOString(),
  expiresAt: new Date(expiredIssued + 5 * 60_000).toISOString(),
  signatureB64: '',
};
expiredOffer.signatureB64 = Buffer.from(signDesktop(companionOfferSignatureText(expiredOffer))).toString('base64');
const companionForward = createCompanionEnvelope(
  {
    kind: 'approval-forward',
    requestId: 'fixture-req-1',
    guardianId: guardianKey.address,
    guardianControlInboxId: 'guardian-inbox',
    companionInboxId: 'phone-inbox',
    sequence: 2,
    // Long-lived so the committed fixture stays valid for on-device tests.
    expiresAt: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString(),
    payload: { operation: 'transaction.propose', requestId: 'fixture-req-1', network: ref.network, summary: { chain: 'xrpl', intentType: 'payment' } },
  },
  signDesktop,
);

const fixtures = {
  secretHex,
  ref,
  commitment,
  addresses0,
  companion: {
    guardianAddress: guardianKey.address,
    authorityIndex: 5,
    expiredOfferJson: JSON.stringify(expiredOffer),
    forwardJson: JSON.stringify(companionForward),
  },
  signatureBlob: {
    signatureHex,
    headerJson: JSON.stringify(sigBlob.header),
    ciphertextB64: Buffer.from(sigBlob.ciphertext).toString('base64'),
  },
  passphraseBlob: {
    kekHex: kat.kekHex,
    passphrase: kat.passphrase,
    headerJson: JSON.stringify(passBlob.header),
    ciphertextB64: Buffer.from(passBlob.ciphertext).toString('base64'),
  },
  xrplSignIn: { blobHex: signInBlobHex, txnSignatureHex },
  signing: {
    xrpl: { unsignedJson: JSON.stringify(xrplUnsigned), expectedTxBlob: xrplSigned.txBlob },
    stellar: { unsignedXdr: stellarUnsigned, network: 'testnet', expectedSignedXdr: stellarSigned },
    evm: { unsignedJson: JSON.stringify(evmUnsigned), expectedSerialized: evmSigned },
  },
};

const outPath = path.join(root, 'vectors', 'swift-fixtures.json');
await writeFile(outPath, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${outPath}`);
