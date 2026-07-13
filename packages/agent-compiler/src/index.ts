import { builtinModules } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { build as esbuild, type Plugin } from 'esbuild';
import ts from 'typescript';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_PACKAGE_PROTOCOL,
  MAX_AGENT_MANIFEST_BYTES,
  MAX_AGENT_PACKAGE_BYTES,
  MAX_AGENT_SOURCE_BYTES,
  artifactDigest,
  assertArtifactManifest,
  assertArtifactPackage,
  assertCanonicalAgentSource,
  canonicalJson,
  sha256Hex,
  type AgentArtifactManifest,
  type AgentArtifactPackage,
  type AgentResourceLimits,
  type CapabilityAllowance,
  type ResourceSlot,
} from '@mosaic/local-runtime';

export interface AgentProjectConfig {
  packageName: string;
  version: string;
  entry: string;
  tsconfig?: string;
  capabilities: {
    required: CapabilityAllowance[];
    optional: CapabilityAllowance[];
  };
  resourceSlots: ResourceSlot[];
  limits: AgentResourceLimits;
  minimumRuntimeVersion: string;
}

export interface CheckResult {
  projectDirectory: string;
  config: AgentProjectConfig;
  warnings: string[];
}

export interface BuildResult extends CheckResult {
  artifact: AgentArtifactPackage;
  outputPath: string;
}

const CONFIG_FILE = 'mosaic.agent.json';
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const TOP_LEVEL_KEYS = new Set([
  'packageName', 'version', 'entry', 'tsconfig', 'capabilities', 'resourceSlots', 'limits', 'minimumRuntimeVersion',
]);

export async function checkAgentProject(project = '.'): Promise<CheckResult> {
  const projectDirectory = resolve(project);
  const config = await readProjectConfig(projectDirectory);
  const entryPath = projectPath(projectDirectory, config.entry, 'entry');
  await access(entryPath);
  const usedOperations = typeCheck(projectDirectory, entryPath, config.tsconfig);
  const declared = new Set([...config.capabilities.required, ...config.capabilities.optional].map(({ operation }) => operation));
  const warnings = [
    ...[...usedOperations].filter((operation) => !declared.has(operation as CapabilityAllowance['operation'])).map((operation) => `statically apparent capability is undeclared: ${operation}`),
    ...[...declared].filter((operation) => !usedOperations.has(operation)).map((operation) => `declared capability has no statically apparent use: ${operation}`),
  ];
  return { projectDirectory, config, warnings };
}

export async function buildAgentProject(project = '.'): Promise<BuildResult> {
  const checked = await checkAgentProject(project);
  const entryPath = projectPath(checked.projectDirectory, checked.config.entry, 'entry');
  const lockfile = await findUp(checked.projectDirectory, 'pnpm-lock.yaml');
  if (!lockfile) throw new Error('a committed pnpm-lock.yaml is required; run pnpm install --frozen-lockfile before building');
  const lockText = await readFile(lockfile, 'utf8');
  const result = await esbuild({
    absWorkingDir: checked.projectDirectory,
    entryPoints: ['mosaic-agent-entry'],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    splitting: false,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    plugins: [virtualEntryPlugin(entryPath, checked.projectDirectory), dependencyPolicyPlugin(lockText)],
    logLevel: 'silent',
  });
  const emitted = result.outputFiles[0]?.text;
  if (emitted === undefined) throw new Error('compiler emitted no source');
  const source = normalizeAndInspectSource(emitted);
  const manifest: AgentArtifactManifest = {
    protocol: AGENT_ARTIFACT_PROTOCOL,
    packageName: checked.config.packageName,
    version: checked.config.version,
    sourceDigest: sha256Hex(source),
    capabilities: checked.config.capabilities,
    resourceSlots: checked.config.resourceSlots,
    limits: checked.config.limits,
    minimumRuntimeVersion: checked.config.minimumRuntimeVersion,
  };
  assertArtifactManifest(manifest);
  const artifact: AgentArtifactPackage = {
    protocol: AGENT_PACKAGE_PROTOCOL,
    manifest,
    source,
    artifactDigest: artifactDigest(manifest),
  };
  assertArtifactPackage(artifact);
  const encoded = canonicalJson(artifact);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_AGENT_PACKAGE_BYTES) throw new Error('agent package exceeds maximum size');
  const outputDirectory = join(checked.projectDirectory, 'dist');
  const outputPath = join(outputDirectory, `${manifest.packageName}-${manifest.version}.mosaic-agent`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, encoded, { encoding: 'utf8', flag: 'w' });
  return { ...checked, artifact, outputPath };
}

function virtualEntryPlugin(entryPath: string, projectDirectory: string): Plugin {
  return {
    name: 'mosaic-agent-virtual-entry',
    setup(build) {
      build.onResolve({ filter: /^mosaic-agent-entry$/ }, () => ({ path: 'entry.ts', namespace: 'mosaic-agent' }));
      build.onLoad({ filter: /^entry\.ts$/, namespace: 'mosaic-agent' }, () => ({
        contents: `import definition from ${JSON.stringify(entryPath)};\nawait definition.run(globalThis.mosaic);\n`,
        loader: 'ts',
        resolveDir: projectDirectory,
      }));
    },
  };
}

export async function inspectAgentPackage(path: string): Promise<AgentArtifactPackage> {
  const statelessBytes = await readFile(resolve(path));
  if (statelessBytes.byteLength > MAX_AGENT_PACKAGE_BYTES) throw new Error('agent package exceeds maximum size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(statelessBytes);
  const value = JSON.parse(text) as AgentArtifactPackage;
  assertArtifactPackage(value);
  if (text !== canonicalJson(value)) throw new Error('agent package envelope must be canonical JSON');
  return value;
}

async function readProjectConfig(projectDirectory: string): Promise<AgentProjectConfig> {
  const bytes = await readFile(join(projectDirectory, CONFIG_FILE));
  if (bytes.byteLength > MAX_AGENT_MANIFEST_BYTES) throw new Error(`${CONFIG_FILE} exceeds maximum size`);
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE} must contain an object`);
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, CONFIG_FILE);
  if (!isRecord(raw.capabilities)) throw new Error('capabilities must be an object');
  rejectUnknownKeys(raw.capabilities, new Set(['required', 'optional']), 'capabilities');
  if (!Array.isArray(raw.capabilities.required) || !Array.isArray(raw.capabilities.optional)) throw new Error('capability lists must be arrays');
  if (!Array.isArray(raw.resourceSlots) || !isRecord(raw.limits)) throw new Error('resourceSlots and limits are required');
  if (typeof raw.entry !== 'string' || raw.entry.length === 0) throw new Error('entry must be a project-relative path');
  if (raw.tsconfig !== undefined && typeof raw.tsconfig !== 'string') throw new Error('tsconfig must be a project-relative path');
  const config = raw as unknown as AgentProjectConfig;
  const placeholderManifest: AgentArtifactManifest = {
    protocol: AGENT_ARTIFACT_PROTOCOL,
    packageName: config.packageName,
    version: config.version,
    sourceDigest: '0'.repeat(64),
    capabilities: config.capabilities,
    resourceSlots: config.resourceSlots,
    limits: config.limits,
    minimumRuntimeVersion: config.minimumRuntimeVersion,
  };
  assertArtifactManifest(placeholderManifest);
  projectPath(projectDirectory, config.entry, 'entry');
  if (config.tsconfig) projectPath(projectDirectory, config.tsconfig, 'tsconfig');
  return config;
}

function typeCheck(projectDirectory: string, entryPath: string, configuredTsconfig: string | undefined): Set<string> {
  const configPath = configuredTsconfig
    ? projectPath(projectDirectory, configuredTsconfig, 'tsconfig')
    : ts.findConfigFile(projectDirectory, ts.sys.fileExists);
  if (!configPath) throw new Error('agent project requires a TypeScript configuration');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw diagnosticsError([read.error]);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), { noEmit: true }, configPath);
  if (parsed.errors.length) throw diagnosticsError(parsed.errors);
  if (parsed.options.strict !== true) throw new Error('agent TypeScript configuration must enable strict mode');
  const roots = parsed.fileNames.includes(entryPath) ? parsed.fileNames : [...parsed.fileNames, entryPath];
  const program = ts.createProgram({ rootNames: roots, options: parsed.options, projectReferences: parsed.projectReferences });
  auditSourceGraph(program, projectDirectory);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw diagnosticsError(diagnostics);
  const entry = program.getSourceFile(entryPath);
  if (!entry) throw new Error('agent entry is outside the TypeScript program');
  const module = program.getTypeChecker().getSymbolAtLocation(entry);
  const defaultExport = module?.exports?.get(ts.InternalSymbolName.Default);
  if (!defaultExport) throw new Error('agent entry must default-export an AgentDefinition');
  const type = program.getTypeChecker().getTypeOfSymbolAtLocation(defaultExport, entry);
  const run = type.getProperty('run');
  if (!run || program.getTypeChecker().getTypeOfSymbolAtLocation(run, entry).getCallSignatures().length === 0) {
    throw new Error('agent default export must be an AgentDefinition with a callable run method');
  }
  return staticallyUsedOperations(program, projectDirectory);
}

function staticallyUsedOperations(program: ts.Program, projectDirectory: string): Set<string> {
  const operations = new Set<string>();
  const mapping = new Map([
    ['log.emit', 'log.emit'], ['clock.now', 'clock.now'], ['random.bytes', 'random.bytes'],
    ['state.get', 'state.get'], ['state.put', 'state.put'], ['state.compareAndSet', 'state.compareAndSet'],
    ['xmtp.send', 'xmtp.send'], ['xmtp.onMessage', 'xmtp.receive'],
  ]);
  for (const file of program.getSourceFiles()) {
    const withinProject = relative(projectDirectory, file.fileName);
    if (file.isDeclarationFile || withinProject === '..' || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)) {
        const apparent = `${node.expression.expression.name.text}.${node.expression.name.text}`;
        const operation = mapping.get(apparent);
        if (operation) operations.add(operation);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return operations;
}

function auditSourceGraph(program: ts.Program, projectDirectory: string): void {
  for (const file of program.getSourceFiles()) {
    const withinProject = relative(projectDirectory, file.fileName);
    if (file.isDeclarationFile || withinProject === '..' || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject)) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (BUILTINS.has(specifier) || specifier.startsWith('node:')) throw new Error(`Node built-in is not allowed: ${specifier}`);
        if (specifier.endsWith('.node')) throw new Error('native .node modules are not allowed');
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error('dynamic import() is not allowed');
      if (ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'Function')) throw new Error(`dynamic code reference is not allowed: ${node.text}`);
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && (node.argumentExpression.text === 'eval' || node.argumentExpression.text === 'Function')) {
        throw new Error(`dynamic code reference is not allowed: ${node.argumentExpression.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}

function dependencyPolicyPlugin(lockText: string): Plugin {
  return {
    name: 'mosaic-agent-dependency-policy',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'dynamic-import') return { errors: [{ text: 'dynamic import() is not allowed' }] };
        if (BUILTINS.has(args.path) || args.path.startsWith('node:')) return { errors: [{ text: `Node built-in is not allowed: ${args.path}` }] };
        if (!isBareSpecifier(args.path)) return undefined;
        const packageName = barePackageName(args.path);
        if (packageName === '@mosaic/agent-sdk') return undefined;
        if (!lockfileContainsPackage(lockText, packageName)) {
          return { errors: [{ text: `dependency is not present in the committed pnpm-lock.yaml: ${packageName}` }] };
        }
        return undefined;
      });
      build.onLoad({ filter: /\.node$/ }, () => ({ errors: [{ text: 'native .node modules are not allowed' }] }));
    },
  };
}

function normalizeAndInspectSource(input: string): string {
  const source = input.replace(/\r\n?/g, '\n');
  assertCanonicalAgentSource(source);
  if (Buffer.byteLength(source, 'utf8') > MAX_AGENT_SOURCE_BYTES) throw new Error('compiled agent source exceeds maximum size');
  const file = ts.createSourceFile('agent.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isImportEqualsDeclaration(node)) {
      throw new Error('compiled source contains an import or export declaration');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error('dynamic import() is not allowed');
    if (ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'Function')) throw new Error(`dynamic code reference is not allowed: ${node.text}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && (node.argumentExpression.text === 'eval' || node.argumentExpression.text === 'Function')) {
      throw new Error(`dynamic code reference is not allowed: ${node.argumentExpression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return source;
}

function diagnosticsError(diagnostics: readonly ts.Diagnostic[]): Error {
  return new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }));
}

function projectPath(projectDirectory: string, configuredPath: string, label: string): string {
  if (isAbsolute(configuredPath)) throw new Error(`${label} must be project-relative`);
  const path = resolve(projectDirectory, configuredPath);
  const back = relative(projectDirectory, path);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Error(`${label} must stay inside the agent project`);
  return path;
}

async function findUp(from: string, name: string): Promise<string | undefined> {
  let directory = from;
  for (;;) {
    const candidate = join(directory, name);
    try { await access(candidate); return candidate; } catch { /* continue upward */ }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field: ${unknown[0]}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBareSpecifier(path: string): boolean {
  return !path.startsWith('.') && !path.startsWith('/') && !path.startsWith('file:');
}

function barePackageName(path: string): string {
  const parts = path.split('/');
  return path.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function lockfileContainsPackage(lockText: string, packageName: string): boolean {
  return lockText.includes(`  ${packageName}@`) || lockText.includes(`      ${JSON.stringify(packageName)}:`) || lockText.includes(`      '${packageName}':`);
}
