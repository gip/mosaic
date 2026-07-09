import { decode, encode, encodeForSigning, XrplDefinitions } from 'ripple-binary-codec';
import { verify as rippleVerify, deriveAddress } from 'ripple-keypairs';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { utf8 } from '@scure/base';
import definitionsJson from 'ripple-binary-codec/dist/enums/definitions.json' with { type: 'json' };
import { canonicalJson } from '../canonical.js';
import { XRPL_MEMO_TYPE, type ZoneMessage } from '../messages.js';

/**
 * Xaman signs zone messages as `SignIn` pseudo-transactions (non-submittable).
 * `SignIn` is not a standard XRPL transaction type; Xaman's codec fork
 * (xrpl-binary-codec-prerelease) assigns it id 999 — we extend the stock
 * definitions identically. The canonical zone message travels in Memos[0]
 * under MemoType "mosaic/zone-v1".
 *
 * The blob Xaman returns for a signed SignIn payload carries NO
 * TransactionType field at all (Flags/Sequence/Fee/SigningPubKey/
 * TxnSignature/Account only) — the app strips the pseudo-type before
 * signing. A blob without a TransactionType can never be submitted, so we
 * accept it; a blob claiming any real transaction type is rejected.
 */

let cachedDefs: XrplDefinitions | undefined;
export function xrplSignInDefinitions(): XrplDefinitions {
  if (!cachedDefs) {
    const base = JSON.parse(JSON.stringify(definitionsJson)) as Record<string, unknown> & {
      TRANSACTION_TYPES: Record<string, number>;
    };
    base.TRANSACTION_TYPES['SignIn'] = 999;
    cachedDefs = new XrplDefinitions(base as unknown as ConstructorParameters<typeof XrplDefinitions>[0]);
  }
  return cachedDefs;
}

function toMemoHex(text: string): string {
  return bytesToHex(utf8ToBytes(text)).toUpperCase();
}

/** The txjson template a Xaman SignIn payload carries for a zone message. */
export function xrplSignInTxJson(message: ZoneMessage): {
  TransactionType: 'SignIn';
  Memos: [{ Memo: { MemoType: string; MemoData: string } }];
} {
  return {
    TransactionType: 'SignIn',
    Memos: [
      {
        Memo: {
          MemoType: toMemoHex(XRPL_MEMO_TYPE),
          MemoData: toMemoHex(canonicalJson(message)),
        },
      },
    ],
  };
}

export interface XrplSignInResult {
  valid: boolean;
  /** Account field of the signed transaction. */
  account?: string;
  /** Address derived from SigningPubKey — equals `account` only when the master key signed. */
  signerAddress?: string;
  signingPubKey?: string;
  /** Decoded canonical JSON from the mosaic memo. */
  memoJson?: string;
  error?: string;
}

interface DecodedSignIn {
  TransactionType?: string;
  Account?: string;
  SigningPubKey?: string;
  TxnSignature?: string;
  Memos?: { Memo?: { MemoType?: string; MemoData?: string } }[];
}

/**
 * Verify a signed Xaman SignIn blob: SignIn type, signature over the signing
 * payload, and (optionally) that the mosaic memo is byte-identical to the
 * expected canonical message. The authoritative-key ledger check (spec §2.3)
 * is I/O and lives in the MCP server — callers there must additionally verify
 * `signerAddress` is currently authoritative for `account`.
 */
export function verifyXrplSignInBlob(
  blobHex: string,
  expected?: { account?: string; message?: ZoneMessage },
): XrplSignInResult {
  const defs = xrplSignInDefinitions();
  let tx: DecodedSignIn;
  try {
    tx = decode(blobHex, defs) as DecodedSignIn;
  } catch (error) {
    return { valid: false, error: `decode failed: ${String(error)}` };
  }
  if (tx.TransactionType !== undefined && tx.TransactionType !== 'SignIn') {
    return { valid: false, error: `not a SignIn transaction: ${tx.TransactionType}` };
  }
  if (!tx.Account || !tx.SigningPubKey || !tx.TxnSignature) {
    return { valid: false, error: 'missing Account/SigningPubKey/TxnSignature' };
  }

  const memo = (tx.Memos ?? []).find((m) => m.Memo?.MemoType?.toUpperCase() === toMemoHex(XRPL_MEMO_TYPE));
  const memoJson = memo?.Memo?.MemoData
    ? utf8.encode(hexToBytes(memo.Memo.MemoData.toLowerCase()))
    : undefined;

  if (expected?.message) {
    const expectedJson = canonicalJson(expected.message);
    if (memoJson !== expectedJson) {
      return { valid: false, error: 'memo does not match expected canonical message' };
    }
  }
  if (expected?.account && tx.Account !== expected.account) {
    return { valid: false, error: `account mismatch: ${tx.Account}` };
  }

  let signatureOk = false;
  try {
    signatureOk = rippleVerify(
      encodeForSigning(tx as Parameters<typeof encodeForSigning>[0], defs),
      tx.TxnSignature,
      tx.SigningPubKey,
    );
  } catch (error) {
    return { valid: false, error: `signature check failed: ${String(error)}` };
  }
  if (!signatureOk) return { valid: false, error: 'invalid signature' };

  return {
    valid: true,
    account: tx.Account,
    signerAddress: deriveAddress(tx.SigningPubKey),
    signingPubKey: tx.SigningPubKey,
    memoJson,
  };
}

/**
 * TxnSignature bytes of a signed SignIn blob — the layer-1 wrapKey ikm for
 * XRPL root wallets (the whole blob contains the signature itself; the
 * signature bytes are the stable secret-carrying part).
 */
export function xrplTxnSignatureBytes(blobHex: string): Uint8Array {
  const tx = decode(blobHex, xrplSignInDefinitions()) as DecodedSignIn;
  if (!tx.TxnSignature) throw new Error('xrpl: blob has no TxnSignature');
  return hexToBytes(tx.TxnSignature.toLowerCase());
}

/** Re-encode helper used by tests to build signed SignIn blobs. */
export function encodeXrplSignIn(tx: object): string {
  return encode(tx as Parameters<typeof encode>[0], xrplSignInDefinitions());
}

export function xrplSigningPayload(tx: object): string {
  return encodeForSigning(tx as Parameters<typeof encodeForSigning>[0], xrplSignInDefinitions());
}
