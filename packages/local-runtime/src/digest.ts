import { createHash } from 'node:crypto';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_PACKAGE_PROTOCOL,
  MAX_AGENT_PACKAGE_BYTES,
  assertArtifactManifest,
  assertCanonicalAgentSource,
  canonicalJson,
  type AgentArtifactPackage,
  type AgentArtifactManifest,
  type DigestHex,
} from './contracts.js';

/**
 * Node-only digest helpers. Kept out of contracts.ts so the browser frontend
 * can import the pure constants/types without pulling in node:crypto.
 */

export function sha256Hex(value: string | Uint8Array): DigestHex {
  return createHash('sha256').update(value).digest('hex');
}

export function contractDigest(value: unknown): DigestHex {
  return sha256Hex(canonicalJson(value));
}

/** Content address for the canonical manifest. The manifest already commits to sourceDigest. */
export function artifactDigest(manifest: AgentArtifactManifest): DigestHex {
  return sha256Hex(`${AGENT_ARTIFACT_PROTOCOL}\n${canonicalJson(manifest)}`);
}

export function assertArtifactPackage(value: AgentArtifactPackage): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent package must be an object');
  const unknown = Object.keys(value).find((key) => !['protocol', 'manifest', 'source', 'artifactDigest'].includes(key));
  if (unknown) throw new Error(`agent package contains unknown field: ${unknown}`);
  if (value.protocol !== AGENT_PACKAGE_PROTOCOL) throw new Error('unsupported agent package');
  if (typeof value.source !== 'string' || typeof value.artifactDigest !== 'string') throw new Error('agent package fields are invalid');
  assertArtifactManifest(value.manifest);
  assertCanonicalAgentSource(value.source);
  if (sha256Hex(value.source) !== value.manifest.sourceDigest) throw new Error('agent package source digest mismatch');
  if (artifactDigest(value.manifest) !== value.artifactDigest) throw new Error('agent package artifact digest mismatch');
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_AGENT_PACKAGE_BYTES) throw new Error('agent package exceeds maximum size');
}
