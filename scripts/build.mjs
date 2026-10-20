import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const staging = resolve(root, `.dist-staging-${process.pid}`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome111', 'es2022'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info'
};

try {
  await Promise.all([
    build({ ...common, entryPoints: [resolve(root, 'src/content/content.ts')], outfile: resolve(staging, 'content.js') }),
    build({ ...common, entryPoints: [resolve(root, 'src/page/page-bridge.ts')], outfile: resolve(staging, 'page-bridge.js') }),
    build({ ...common, entryPoints: [resolve(root, 'src/background.ts')], outfile: resolve(staging, 'background.js') }),
    build({ ...common, entryPoints: [resolve(root, 'src/popup/popup.ts')], outfile: resolve(staging, 'popup.js'), loader: { '.css': 'css' } })
  ]);

  cpSync(resolve(root, 'public/manifest.json'), resolve(staging, 'manifest.json'));
  const modelsSource = resolve(root, 'public/models');
  const modelPath = resolve(modelsSource, 'selfie_segmenter.tflite');
  if (!existsSync(modelPath)) throw new Error('The local segmentation model is missing: public/models/selfie_segmenter.tflite');
  const modelsDist = resolve(staging, 'models');
  mkdirSync(modelsDist, { recursive: true });
  for (const file of readdirSync(modelsSource)) {
    cpSync(resolve(modelsSource, file), resolve(modelsDist, file));
  }

  const wasmSource = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  if (!existsSync(wasmSource)) {
    throw new Error('MediaPipe WASM assets are missing. Run npm ci before building.');
  }
  const wasmDist = resolve(staging, 'wasm');
  mkdirSync(wasmDist, { recursive: true });
  for (const file of readdirSync(wasmSource)) {
    cpSync(resolve(wasmSource, file), resolve(wasmDist, file));
  }
  cpSync(resolve(root, 'src/popup/popup.html'), resolve(staging, 'popup.html'));
  cpSync(resolve(root, 'src/popup/popup.css'), resolve(staging, 'popup.css'));

  const manifestPath = resolve(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = process.env.SNAP_VERSION || process.env.VEYL_VERSION || manifest.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const requiredFiles = [
    'manifest.json',
    'content.js',
    'page-bridge.js',
    'background.js',
    'popup.html',
    'popup.js',
    'popup.css',
    'models/selfie_segmenter.tflite'
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(resolve(staging, relativePath))) throw new Error(`Build output is missing ${relativePath}`);
  }

  rmSync(dist, { recursive: true, force: true });
  renameSync(staging, dist);
  console.log(`Veyl/Snap extension built in ${dist}`);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
