import {
  summarizeTradingSystemConfig,
  validateTradingSystemConfigFile,
  writeExampleTradingSystemConfig,
} from '../runtime/runtime-config.js';
import { getErrorMessage } from '../utils/errors.js';

type RuntimeConfigCommand =
  | { command: 'generate'; path: string; force: boolean }
  | { command: 'validate'; path: string };

function parseCommand(argv: string[]): RuntimeConfigCommand {
  const command = argv[2];
  const args = argv.slice(3);
  const force = args.includes('--force');
  const positionalArgs = args.filter((arg) => arg !== '--force');
  const path = positionalArgs[0] ?? './config/trading-system.json';

  if (command === 'generate') {
    return { command, path, force };
  }

  if (command === 'validate') {
    return { command, path };
  }

  throw new Error(
    'Usage: node dist/src/scripts/runtime-config.js <generate|validate> [path] [--force]'
  );
}

function main(): Promise<void> {
  const parsed = parseCommand(process.argv);

  if (parsed.command === 'generate') {
    const config = writeExampleTradingSystemConfig(parsed.path, { force: parsed.force });
    console.log(
      JSON.stringify(
        {
          path: parsed.path,
          generated: true,
          overwritten: parsed.force,
          summary: summarizeTradingSystemConfig(config),
        },
        null,
        2
      )
    );
    return Promise.resolve();
  }

  const result = validateTradingSystemConfigFile(parsed.path);
  console.log(
    JSON.stringify(
      {
        path: result.path,
        valid: true,
        summary: result.summary,
      },
      null,
      2
    )
  );

  return Promise.resolve();
}

main().catch((error: unknown) => {
  console.error(`Runtime config command failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
