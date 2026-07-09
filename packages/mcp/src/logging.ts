export interface MosaicLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/** stderr logger — stdout belongs to the MCP stdio transport. Redacts nothing
 * because nothing secret is ever logged; keep it that way. */
export function createStderrLogger(prefix = 'mosaic-mcp'): Required<MosaicLogger> {
  const line = (level: string, message: string) =>
    process.stderr.write(`${new Date().toISOString()} [${prefix}] ${level} ${message}\n`);
  return {
    debug: (m) => line('DEBUG', m),
    info: (m) => line('INFO', m),
    warn: (m) => line('WARN', m),
    error: (m) => line('ERROR', m),
  };
}
