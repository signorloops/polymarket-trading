import { parseCommand } from '../../src/scripts/runtime-config.js';

describe('runtime config command parsing', () => {
  it('validates the committed example when no path is supplied', () => {
    expect(parseCommand(['node', 'runtime-config.js', 'validate'])).toEqual({
      command: 'validate',
      path: './config/trading-system.example.json',
    });
  });

  it('generates the operator config when no path is supplied', () => {
    expect(parseCommand(['node', 'runtime-config.js', 'generate'])).toEqual({
      command: 'generate',
      path: './config/trading-system.json',
      force: false,
    });
  });

  it('preserves an explicitly supplied validation path', () => {
    expect(parseCommand(['node', 'runtime-config.js', 'validate', '/tmp/runtime.json'])).toEqual({
      command: 'validate',
      path: '/tmp/runtime.json',
    });
  });
});
