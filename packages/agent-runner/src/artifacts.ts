import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  artifactDigest,
  assertArtifactManifest,
  assertCanonicalAgentSource,
  sha256Hex,
  type AgentArtifactManifest,
} from '@mosaic/local-runtime';
import type { ArtifactDownloader } from './multiSupervisor.js';

export class McpArtifactDownloader implements ArtifactDownloader {
  private clientPromise?: Promise<McpClient>;

  constructor(private readonly url = process.env.MOSAIC_MCP_URL ?? 'http://127.0.0.1:8788/mcp') {}

  private connect(): Promise<McpClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = new McpClient({ name: 'mosaic-supervisor-artifacts', version: '3.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
        return client;
      })();
    }
    return this.clientPromise;
  }

  async download(ticket: string): Promise<{ artifactDigest: string; runnerCertificateDigest: string; manifest: AgentArtifactManifest; source: string }> {
    const client = await this.connect();
    const result = await client.callTool({ name: 'agent_artifact_download', arguments: { ticket } });
    const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text ?? '{}';
    const value = JSON.parse(text) as {
      artifactDigest: string; runnerCertificateDigest: string; manifest: AgentArtifactManifest; source: string;
      error?: { message?: string };
    };
    if (result.isError) throw new Error(value.error?.message ?? 'artifact download failed');
    assertArtifactManifest(value.manifest);
    assertCanonicalAgentSource(value.source);
    if (artifactDigest(value.manifest) !== value.artifactDigest || sha256Hex(value.source) !== value.manifest.sourceDigest) {
      throw new Error('downloaded artifact integrity mismatch');
    }
    return value;
  }
}
