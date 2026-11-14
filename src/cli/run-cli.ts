import { CONFIG_ERROR_EXIT_CODE, ConfigError } from '../platform/config/app-config';

/**
 * Runs a command-line task. A configuration problem prints the key names and exits 78; any other failure prints
 * one line with its cause chain and exits 1. Neither prints a stack trace to a person running setup.
 */
export function runCli(name: string, task: () => Promise<void>): void {
  task().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${name}: ${error.message}\n`);
      process.exit(CONFIG_ERROR_EXIT_CODE);
    }
    const chain: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      chain.push(current.message);
    }
    process.stderr.write(`${name}: ${chain.length > 0 ? chain.join(': ') : String(error)}\n`);
    process.exit(1);
  });
}
