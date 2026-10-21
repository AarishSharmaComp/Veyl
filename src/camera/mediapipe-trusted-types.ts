const ADAPTER_STATE = '__veylMediaPipeTrustedTypesAdapter';
const CREATE_SCRIPT_URL = '__veylMediaPipeCreateScriptUrl';
const ALLOWED_LOADER_PATHS = [
  '/wasm/vision_wasm_internal.js',
  '/wasm/vision_wasm_nosimd_internal.js',
  '/wasm/vision_wasm_module_internal.js'
] as const;
let workerPolicy: TrustedTypesPolicy | null = null;
const approvedWorkerUrls = new Set<string>();

interface TrustedTypesPolicy {
  createScriptURL(value: string): unknown;
}

interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): TrustedTypesPolicy;
}

interface MediaPipePageGlobals {
  trustedTypes?: TrustedTypesLike;
  [ADAPTER_STATE]?: { extensionBaseUrl: string };
  [CREATE_SCRIPT_URL]?: (value: string) => unknown;
}

/**
 * MediaPipe 0.10.35 loads its local Emscripten loader with a dynamic script
 * element. The page's Trusted Types policy must approve only those exact
 * packaged extension resources; no page-wide default policy is installed.
 */
export function installMediaPipeTrustedTypesAdapter(assetBaseUrl: string): void {
  const page = globalThis as typeof globalThis & MediaPipePageGlobals;
  const base = parseExtensionBaseUrl(assetBaseUrl);
  const extensionOrigin = `${base.protocol}//${base.hostname}${base.port ? `:${base.port}` : ''}`;
  const existing = page[ADAPTER_STATE];
  if (existing) {
    if (existing.extensionBaseUrl === base.href && typeof page[CREATE_SCRIPT_URL] === 'function') return;
    throw new Error('[Veyl] MediaPipe Trusted Types adapter is already bound to another extension origin.');
  }
  if (page[CREATE_SCRIPT_URL]) {
    throw new Error('[Veyl] MediaPipe Trusted Types adapter name is already occupied by page code.');
  }

  const validateLoaderUrl = (value: string): string => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new Error(`[Veyl] MediaPipe rejected a non-URL loader source: ${toErrorMessage(error)}`);
    }
    const allowed = url.protocol === base.protocol && url.hostname === base.hostname && url.port === base.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      ALLOWED_LOADER_PATHS.some((path) => url.pathname === path || url.pathname === path.replace('/wasm/', '/wasm//'));
    if (!allowed) {
      throw new Error(`[Veyl] MediaPipe rejected an unapproved loader source: ${url.href}`);
    }
    return url.href;
  };

  const trustedTypes = page.trustedTypes;
  let createScriptUrl: (value: string) => unknown;
  if (trustedTypes) {
    const policyName = `veyl-mediapipe-loader-${base.hostname}`;
    let policy: TrustedTypesPolicy;
    try {
      policy = trustedTypes.createPolicy(policyName, {
        createScriptURL: validateLoaderUrl
      });
    } catch (error) {
      const message = `[Veyl] MediaPipe Trusted Types policy creation was disallowed for ${extensionOrigin}: ${toErrorMessage(error)}`;
      console.error(message, error);
      throw new Error(message);
    }
    createScriptUrl = (value) => policy.createScriptURL(value);
  } else {
    // Browsers without Trusted Types do not need a policy, but still get the
    // same exact packaged-resource validation before the script sink.
    createScriptUrl = validateLoaderUrl;
  }

  Object.defineProperty(page, CREATE_SCRIPT_URL, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: createScriptUrl
  });
  Object.defineProperty(page, ADAPTER_STATE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { extensionBaseUrl: base.href }
  });
}

export function createMediaPipeScriptUrl(value: string): unknown {
  const page = globalThis as typeof globalThis & MediaPipePageGlobals;
  const createScriptUrl = page[CREATE_SCRIPT_URL];
  if (typeof createScriptUrl !== 'function') throw new Error('[Veyl] MediaPipe Trusted Types adapter is not installed.');
  return createScriptUrl(value);
}

export function registerMediaPipeWorkerScriptUrl(value: string): void {
  const page = globalThis as typeof globalThis & MediaPipePageGlobals;
  if (!page[ADAPTER_STATE] || !value.startsWith('blob:')) {
    throw new Error('[Veyl] MediaPipe worker URL was not created by VEYL.');
  }
  approvedWorkerUrls.add(value);
}

export function createMediaPipeWorkerScriptUrl(value: string): unknown {
  const page = globalThis as typeof globalThis & MediaPipePageGlobals;
  const adapter = page[ADAPTER_STATE];
  if (!adapter || !value.startsWith('blob:') || !approvedWorkerUrls.has(value)) {
    throw new Error('[Veyl] MediaPipe worker URL was not created by VEYL.');
  }
  const trustedTypes = page.trustedTypes;
  try {
    if (!trustedTypes) return value;
    workerPolicy ??= trustedTypes.createPolicy(`veyl-mediapipe-worker-${new URL(adapter.extensionBaseUrl).hostname}`, {
      createScriptURL(candidate: string): string {
        if (!approvedWorkerUrls.has(candidate)) throw new Error('[Veyl] MediaPipe worker URL was not approved.');
        return candidate;
      }
    });
    return workerPolicy.createScriptURL(value);
  } finally {
    approvedWorkerUrls.delete(value);
  }
}

function parseExtensionBaseUrl(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch (error) {
    throw new Error(`[Veyl] MediaPipe Trusted Types adapter received an invalid asset base URL: ${toErrorMessage(error)}`);
  }
  if (base.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/.test(base.hostname) || base.port ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('[Veyl] MediaPipe Trusted Types adapter requires the current chrome-extension root origin.');
  }
  return base;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
