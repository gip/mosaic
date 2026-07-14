#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { argon2id } from 'hash-wasm';
import {
  ARGON2_PARAMS_V1,
  decodeBackupBlob,
  decodeVaultDataBackupBlob,
  deriveEvmAgentKey,
  deriveStellarAgentKey,
  deriveXrplAgentKey,
  openPassphraseBlob,
  openVaultData,
  passphraseKdfParams,
  zoneSeed,
} from '../dist/index.js';

const MAX_DERIVATION_INDEX = 0x7fffffff;

function usage() {
  return `Usage:
  pnpm vault:recover [backup.json] [--index <n[,n...]>] [--show-private-keys]

Options:
  --index <n>           Derive an account index. Repeat it or use commas.
                        Defaults to index 0.
  --show-private-keys  Include derived private keys in the JSON output.
  --help                Show this help.

The backup passphrase is always prompted for and is never accepted as a
command-line argument, so it does not enter shell history.`;
}

function fail(message) {
  throw new Error(message);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

/** Validate the identity envelope before expensive Argon2 work. */
export function parseBackupJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('backup is not valid JSON');
  }
  const backup = requireRecord(parsed, 'backup');
  if (backup.format !== 'mosaic-zone-backup' || backup.v !== 1) fail('unsupported Mosaic backup format or version');
  if (backup.protocol !== 'MOSAIC_ZONE_DERIVATION_V1') fail('unsupported Mosaic backup protocol');
  if (!['evm', 'xrpl', 'stellar'].includes(backup.rootChain)) fail('backup.rootChain is invalid');
  if (!['mainnet', 'testnet'].includes(backup.network)) fail('backup.network is invalid');
  requireString(backup.rootAddress, 'backup.rootAddress');
  requireString(backup.zone, 'backup.zone');
  requireString(backup.createdAt, 'backup.createdAt');
  if (typeof backup.commitment !== 'string' || !/^[0-9a-fA-F]{64}$/.test(backup.commitment)) {
    fail('backup.commitment must be a 32-byte hexadecimal value');
  }
  const blobs = requireRecord(backup.blobs, 'backup.blobs');
  requireRecord(blobs.pass, 'backup.blobs.pass');
  return backup;
}

export function parseCliArgs(argv) {
  const options = { backupPath: undefined, indexes: [], showPrivateKeys: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--show-private-keys') {
      options.showPrivateKeys = true;
    } else if (arg === '--index') {
      const value = argv[++i];
      if (value === undefined) fail('--index requires a value');
      for (const part of value.split(',')) {
        if (!/^\d+$/.test(part)) fail(`invalid derivation index: ${part}`);
        const index = Number(part);
        if (!Number.isSafeInteger(index) || index > MAX_DERIVATION_INDEX) fail(`derivation index is out of range: ${part}`);
        options.indexes.push(index);
      }
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    } else if (options.backupPath === undefined) {
      options.backupPath = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  options.indexes = [...new Set(options.indexes.length ? options.indexes : [0])].sort((a, b) => a - b);
  return options;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function keyReport(key, path, showPrivateKeys) {
  const report = {
    path,
    address: key.address,
    publicKeyHex: hex(key.publicKey),
  };
  if (showPrivateKeys) {
    if (key.chain === 'evm') report.privateKeyHex = `0x${hex(key.privateKey)}`;
    else if (key.chain === 'xrpl') report.privateKeyHex = hex(key.privateKey);
    else report.privateKeySeedHex = hex(key.privateKey);
  }
  key.privateKey.fill(0);
  key.publicKey.fill(0);
  return report;
}

/** Build printable output without ever including zoneRootSecret itself. */
export function buildRecoveryReport(backup, secret, indexes, showPrivateKeys) {
  const ref = {
    rootChain: backup.rootChain,
    rootAddress: backup.rootAddress,
    zone: backup.zone,
    network: backup.network,
  };
  let vaultData = null;
  if (backup.data !== undefined) {
    vaultData = openVaultData(secret, ref, decodeVaultDataBackupBlob(requireRecord(backup.data, 'backup.data')));
  }

  const seed = zoneSeed(secret, ref);
  try {
    const derivedAccounts = indexes.map((index) => ({
      index,
      evm: keyReport(deriveEvmAgentKey(seed, index), `m/44'/60'/0'/0/${index}`, showPrivateKeys),
      xrpl: keyReport(deriveXrplAgentKey(seed, index), `m/44'/144'/0'/0/${index}`, showPrivateKeys),
      stellar: keyReport(deriveStellarAgentKey(seed, index), `m/44'/148'/${index}'`, showPrivateKeys),
    }));
    return {
      backup: {
        format: backup.format,
        version: backup.v,
        protocol: backup.protocol,
        rootChain: backup.rootChain,
        rootAddress: backup.rootAddress,
        zone: backup.zone,
        network: backup.network,
        commitment: backup.commitment.toLowerCase(),
        createdAt: backup.createdAt,
        recoveryBlobs: Object.keys(backup.blobs).sort(),
      },
      recovery: {
        method: 'passphrase',
        commitmentVerified: true,
        privateKeysIncluded: showPrivateKeys,
      },
      vaultData,
      derivedAccounts,
      note: 'The backup file does not contain the backend address registry. Index 0 is shown by default; use --index for additional derived accounts.',
    };
  } finally {
    seed.fill(0);
  }
}

async function deriveKek(passphrase, salt, params) {
  return argon2id({
    password: passphrase,
    salt,
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: 32,
    outputType: 'binary',
  });
}

export async function recoverBackup(backup, passphrase, indexes = [0], showPrivateKeys = false) {
  const ref = {
    rootChain: backup.rootChain,
    rootAddress: backup.rootAddress,
    zone: backup.zone,
    network: backup.network,
  };
  const wrapped = decodeBackupBlob(backup.blobs.pass);
  const params = passphraseKdfParams(wrapped);
  if (params.m !== ARGON2_PARAMS_V1.m || params.t !== ARGON2_PARAMS_V1.t || params.p !== ARGON2_PARAMS_V1.p) {
    fail('backup uses unsupported Argon2id parameters');
  }
  const kek = await deriveKek(passphrase, params.saltBytes, params);
  let secret;
  try {
    try {
      secret = openPassphraseBlob(kek, wrapped, ref, backup.commitment.toLowerCase());
    } catch {
      fail('backup passphrase is incorrect, or the backup is damaged or does not match its vault metadata');
    }
    return buildRecoveryReport(backup, secret, indexes, showPrivateKeys);
  } finally {
    kek.fill(0);
    secret?.fill(0);
  }
}

async function promptLine(label, hidden = false) {
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(label);
    } finally {
      rl.close();
    }
  }

  // readline controls terminal echo, while this sink suppresses its redraws.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  process.stderr.write(label);
  const rl = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
  try {
    const answer = await rl.question('');
    process.stderr.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const backupPath = options.backupPath || await promptLine('Backup JSON path: ');
  if (!backupPath.trim()) fail('a backup JSON path is required');
  // pnpm --filter runs this package script from packages/zone-keys. INIT_CWD
  // preserves the directory where the user invoked the root command.
  const inputPath = resolve(process.env.INIT_CWD || process.cwd(), backupPath.trim());
  const backup = parseBackupJson(await readFile(inputPath, 'utf8'));
  const passphrase = await promptLine('Backup passphrase: ', true);
  if (!passphrase) fail('backup passphrase cannot be empty');

  process.stderr.write('Deriving the recovery key with Argon2id (this is intentionally slow)…\n');
  if (options.showPrivateKeys) {
    process.stderr.write('WARNING: derived private keys will be printed to standard output. Keep that output secret.\n');
  }
  const report = await recoverBackup(backup, passphrase, options.indexes, options.showPrivateKeys);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
