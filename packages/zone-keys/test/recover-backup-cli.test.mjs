import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes } from '@noble/hashes/utils.js';
import { deriveAgentAddresses, encodeBackupFile, sealPassphraseBlob, sealVaultData, zoneRootCommitmentHex } from '../dist/index.js';
import { buildRecoveryReport, parseBackupJson, parseCliArgs } from '../scripts/recover-backup.mjs';

const secret = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const ref = {
  rootChain: 'evm',
  rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  zone: 'top',
  network: 'mainnet',
};

function backupFixture() {
  const pass = sealPassphraseBlob(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), secret, ref);
  const data = sealVaultData(secret, ref, { v: 1, extensions: { label: 'recovered' } }, 1);
  return encodeBackupFile(ref, zoneRootCommitmentHex(secret), { pass }, '2026-07-14T00:00:00.000Z', data);
}

test('recovery CLI validates backup identity and options', () => {
  const backup = parseBackupJson(JSON.stringify(backupFixture()));
  assert.equal(backup.zone, 'top');
  assert.deepEqual(parseCliArgs(['backup.json', '--index', '2,0', '--index', '2', '--show-private-keys']), {
    backupPath: 'backup.json', indexes: [0, 2], showPrivateKeys: true, help: false,
  });
  assert.throws(() => parseBackupJson('{}'), /unsupported Mosaic backup/);
  assert.throws(() => parseCliArgs(['--index', '-1']), /invalid derivation index/);
});

test('recovery report decrypts vault data and omits private material by default', () => {
  const backup = backupFixture();
  const report = buildRecoveryReport(backup, secret.slice(), [0], false);
  assert.equal(report.recovery.commitmentVerified, true);
  assert.deepEqual(report.vaultData, { v: 1, extensions: { label: 'recovered' } });
  assert.equal(report.derivedAccounts[0].evm.address, deriveAgentAddresses(secret, ref, 0).evm);
  assert.equal('privateKeyHex' in report.derivedAccounts[0].evm, false);
  assert.equal('privateKeyHex' in report.derivedAccounts[0].xrpl, false);
  assert.equal('privateKeySeedHex' in report.derivedAccounts[0].stellar, false);
});

test('recovery report includes all three private key encodings only on request', () => {
  const report = buildRecoveryReport(backupFixture(), secret.slice(), [0], true);
  assert.match(report.derivedAccounts[0].evm.privateKeyHex, /^0x[0-9a-f]{64}$/);
  assert.match(report.derivedAccounts[0].xrpl.privateKeyHex, /^[0-9a-f]{64}$/);
  assert.match(report.derivedAccounts[0].stellar.privateKeySeedHex, /^[0-9a-f]{64}$/);
});
