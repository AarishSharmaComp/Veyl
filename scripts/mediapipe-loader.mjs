import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const loaderAssignment = 'e.src=t.toString()';
const adaptedLoaderAssignment = 'e.src=globalThis.__veylMediaPipeCreateScriptUrl(t.toString())';
// The locked bundle's identity policy would approve arbitrary script URLs in
// the shared page world. Remove it so Veyl is the only policy at this boundary.
const closureTrustedTypesPolicy = 'let ji,Vi=globalThis.trustedTypes;function Xi(t){var e;return void 0===ji&&(ji=function(){let t=null;if(!Vi)return t;try{const e=t=>t;t=Vi.createPolicy("goog#html",{createHTML:e,createScript:e,createScriptURL:e})}catch(t){}return t}()),t=(e=ji)?e.createScriptURL(t):t,new class{constructor(t){this.g=t}toString(){return this.g+""}}(t)}';
const closureTrustedTypesReplacement = 'function Xi(t){return new class{constructor(t){this.g=t}toString(){return this.g+""}}(t)}';

/**
 * @param {string} source
 * @param {string} sourcePath
 */
export function adaptMediaPipeVisionBundle(source, sourcePath = '@mediapipe/tasks-vision/vision_bundle.mjs') {
  const policyMatches = source.split(closureTrustedTypesPolicy).length - 1;
  if (policyMatches !== 1) {
    throw new Error(`MediaPipe loader transform expected one upstream identity Trusted Types policy in ${sourcePath}; found ${policyMatches}.`);
  }
  const matches = source.split(loaderAssignment).length - 1;
  if (matches !== 1) {
    throw new Error(`MediaPipe loader transform expected one script.src assignment in ${sourcePath}; found ${matches}.`);
  }
  const transformed = source.replace(closureTrustedTypesPolicy, closureTrustedTypesReplacement)
    .replace(loaderAssignment, adaptedLoaderAssignment);
  if (transformed.includes('.createPolicy(')) {
    throw new Error(`MediaPipe loader transform found an unexpected Trusted Types policy in ${sourcePath}.`);
  }
  return transformed;
}

export function createMediaPipeLoaderPlugin() {
  return {
    name: 'veyl-mediapipe-trusted-types-loader',
    setup(build) {
      build.onLoad({ filter: /[\\/]@mediapipe[\\/]tasks-vision[\\/]vision_bundle\.(?:mjs|cjs)$/ }, (args) => ({
        contents: adaptMediaPipeVisionBundle(readFileSync(args.path, 'utf8'), args.path),
        loader: 'js',
        resolveDir: dirname(args.path)
      }));
    }
  };
}
