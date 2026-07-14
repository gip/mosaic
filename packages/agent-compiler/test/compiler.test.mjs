import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAgentProject, checkAgentProject, inspectAgentPackage } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture');

test('build is byte-identical across runs and absolute directories, and virtual entry awaits the handler', async () => {
  const one = await isolatedFixture();
  const two = await isolatedFixture();
  try {
    const first = await buildAgentProject(one);
    const repeated = await buildAgentProject(one);
    const second = await buildAgentProject(two);
    const firstBytes = await readFile(first.outputPath);
    assert.deepEqual(firstBytes, await readFile(repeated.outputPath));
    assert.deepEqual(firstBytes, await readFile(second.outputPath));
    const inspected = await inspectAgentPackage(first.outputPath);
    assert.equal(inspected.artifactDigest, first.artifact.artifactDigest);
    assert.doesNotMatch(inspected.source, /\b(?:import|export)\b/);
    globalThis.mosaic = { log: { emit: async (entry) => { globalThis.__agentCompilerMessage = entry.message; } } };
    await import(`data:text/javascript,${encodeURIComponent(inspected.source)}#success`);
    assert.equal(globalThis.__agentCompilerMessage, 'compiled');
  } finally {
    delete globalThis.mosaic;
    delete globalThis.__agentCompilerMessage;
    await Promise.all([rm(one, { recursive: true, force: true }), rm(two, { recursive: true, force: true })]);
  }
});

test('compiler rejects dynamic code, dynamic imports, and Node built-ins', async () => {
  for (const [name, source, pattern] of [
    ['eval', `export default { async run() { globalThis['eval']('1'); } };`, /dynamic code reference/],
    ['function', `export default { async run() { const Maker = globalThis.Function; return Maker(''); } };`, /dynamic code reference/],
    ['dynamic-import', `export default { async run() { await import('./helper.js'); } };`, /dynamic import/],
    ['node', `import fs from 'node:fs'; export default { async run() { void fs; } };`, /Node built-in/],
  ]) {
    const project = await isolatedFixture();
    try {
      await writeFile(join(project, 'src', 'agent.ts'), source);
      await assert.rejects(() => buildAgentProject(project), pattern, name);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('check rejects unsupported capabilities before code can grant authority', async () => {
  const project = await isolatedFixture();
  try {
    const configPath = join(project, 'mosaic.agent.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.capabilities.required = [{ operation: 'transaction.propose', maxCalls: 1, maxResponseBytes: 10 }];
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(() => checkAgentProject(project), /policy broker is not implemented/);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('capability analysis warns but never changes package authority', async () => {
  const project = await isolatedFixture();
  try {
    await writeFile(join(project, 'src', 'agent.ts'), `import { defineAgent } from '@mosaic/agent-sdk'; export default defineAgent(async (mosaic) => { await mosaic.clock.now(); });`);
    const checked = await checkAgentProject(project);
    assert(checked.warnings.some((warning) => warning.includes('undeclared: clock.now')));
    assert(checked.warnings.some((warning) => warning.includes('no statically apparent use: log.emit')));
    const built = await buildAgentProject(project);
    assert.deepEqual(built.artifact.manifest.capabilities.required.map(({ operation }) => operation), ['log.emit']);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('a rejected handler promise propagates from the virtual entry', async () => {
  const project = await isolatedFixture();
  try {
    await writeFile(join(project, 'src', 'agent.ts'), `import { defineAgent } from '@mosaic/agent-sdk'; export default defineAgent(async () => { throw new Error('handler failed'); });`);
    const built = await buildAgentProject(project);
    globalThis.mosaic = {};
    await assert.rejects(() => import(`data:text/javascript,${encodeURIComponent(built.artifact.source)}#failure`), /handler failed/);
  } finally {
    delete globalThis.mosaic;
    await rm(project, { recursive: true, force: true });
  }
});

async function isolatedFixture() {
  const directory = await mkdtemp(join(here, '.fixture-'));
  await cp(fixture, directory, { recursive: true });
  return directory;
}
