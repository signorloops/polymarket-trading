import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(
  importMetaUrl: string,
  argvPath: string | undefined = process.argv[1],
  cwd: string = process.cwd()
): boolean {
  if (!argvPath) {
    return false;
  }

  return importMetaUrl === pathToFileURL(resolve(cwd, argvPath)).href;
}
