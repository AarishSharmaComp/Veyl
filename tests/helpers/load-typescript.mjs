import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function loadTypescript(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'esm', target: 'es2022' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
