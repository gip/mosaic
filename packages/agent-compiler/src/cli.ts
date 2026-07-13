#!/usr/bin/env node
import { canonicalJson } from '@mosaic/local-runtime';
import { buildAgentProject, checkAgentProject, inspectAgentPackage } from './index.js';

async function main(argv: string[]): Promise<void> {
  const [command, target] = argv;
  switch (command) {
    case 'build': {
      const result = await buildAgentProject(target ?? '.');
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      console.log(`${result.artifact.artifactDigest}  ${result.outputPath}`);
      return;
    }
    case 'check': {
      const result = await checkAgentProject(target ?? '.');
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      console.log(`valid agent project: ${result.config.packageName}@${result.config.version}`);
      return;
    }
    case 'inspect': {
      if (!target) throw new Error('usage: mosaic-agent inspect <artifact>');
      const artifact = await inspectAgentPackage(target);
      console.log(canonicalJson({ artifactDigest: artifact.artifactDigest, manifest: artifact.manifest }));
      return;
    }
    default:
      throw new Error('usage: mosaic-agent <build|check> [project]\n       mosaic-agent inspect <artifact>');
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
