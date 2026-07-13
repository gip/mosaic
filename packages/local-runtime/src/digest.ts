import { createHash } from 'node:crypto';
import {
  AGENT_ARTIFACT_PROTOCOL,
  canonicalJson,
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
