import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../../src/runtime/entrypoint.js';

describe('isMainModule', () => {
  it('recognizes both relative and absolute entrypoint paths', () => {
    const cwd = '/tmp/project';
    const absolutePath = resolve(cwd, 'dist/src/index.js');
    const importMetaUrl = pathToFileURL(absolutePath).href;

    expect(isMainModule(importMetaUrl, 'dist/src/index.js', cwd)).toBe(true);
    expect(isMainModule(importMetaUrl, absolutePath, cwd)).toBe(true);
  });

  it('does not treat imports or a missing argv path as direct execution', () => {
    expect(isMainModule('file:///tmp/project/dist/src/index.js', undefined)).toBe(false);
    expect(
      isMainModule(
        'file:///tmp/project/dist/src/index.js',
        '/tmp/project/dist/src/other.js',
        '/tmp/project'
      )
    ).toBe(false);
  });
});
