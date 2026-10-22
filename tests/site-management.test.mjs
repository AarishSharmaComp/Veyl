import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypescript } from './helpers/load-typescript.mjs';

const { describeSiteUrl, parseWebsiteEntry } = await loadTypescript('../../src/shared/sites.ts');
const { SiteManager } = await loadTypescript('../../src/integration/site-manager.ts');
const { migrateStoredState } = await loadTypescript('../../src/shared/site-storage.ts');
const { sanitizeSettings } = await loadTypescript('../../src/shared/settings.ts');
const { isBackgroundPlate } = await loadTypescript('../../src/shared/background-plate.ts');

const meet = 'https://meet.google.com';
const site = 'https://video.example';
const pattern = `${site}:443/*`;
const plate = { dataUrl: 'data:image/jpeg;base64,YWJj', width: 640, height: 480, capturedAt: 1 };

function environment(initial = {}) {
  let stored = structuredClone(initial);
  const permissions = new Set([`${meet}:443/*`]);
  const registered = new Map();
  const notices = [];
  const browser = {
    storage: { local: {
      async get() { await Promise.resolve(); return structuredClone(stored); },
      async set(values) { await Promise.resolve(); stored = { ...stored, ...structuredClone(values) }; }
    } },
    permissions: {
      async contains({ origins }) { return origins.every((origin) => permissions.has(origin)); },
      async remove({ origins }) { origins.forEach((origin) => permissions.delete(origin)); return true; }
    },
    scripting: {
      async getRegisteredContentScripts() { return structuredClone([...registered.values()]); },
      async registerContentScripts(scripts) {
        for (const script of scripts) { assert.ok(!registered.has(script.id)); registered.set(script.id, structuredClone(script)); }
      },
      async updateContentScripts(scripts) { for (const script of scripts) registered.set(script.id, structuredClone(script)); },
      async unregisterContentScripts({ ids }) { ids.forEach((id) => registered.delete(id)); }
    },
    tabs: { async query() { return [{ id: 2 }, { id: 3 }]; }, async sendMessage(id, message) { notices.push({ id, message }); } }
  };
  const manager = new SiteManager(browser);
  return { manager, permissions, registered, notices, browser, get stored() { return stored; } };
}

test('exact origin normalization retains nondefault ports and excludes sibling hosts', () => {
  assert.equal(describeSiteUrl('https://EXAMPLE.com/path?x=1').siteKey, 'https://example.com');
  assert.equal(describeSiteUrl('https://example.com').matchPattern, 'https://example.com:443/*');
  assert.equal(describeSiteUrl('https://example.com:8443/path').matchPattern, 'https://example.com:8443/*');
  assert.notEqual(describeSiteUrl('https://sub.example.com').siteKey, describeSiteUrl('https://example.com').siteKey);
  assert.equal(describeSiteUrl('http://localhost:3000/camera').siteKey, 'http://localhost:3000');
  assert.equal(describeSiteUrl('http://127.0.0.1:1234').matchPattern, 'http://127.0.0.1:1234/*');
});

for (const entry of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/x', 'chrome://settings',
  'chrome-extension://abc/popup.html', 'https://a:b@example.com', 'https://*.example.com',
  'http://example.com', 'http://localhost.evil.test', 'bad host.com', 'https://foo\\@evil.com', '']) {
  test(`unsafe/unsupported website entry rejected: ${entry || '(empty)'}`, () => assert.equal(parseWebsiteEntry(entry), null));
}
test('domain entry is convenient without granting access to other origins', () => {
  assert.equal(parseWebsiteEntry(' video.example/path ').siteKey, site);
  assert.equal(parseWebsiteEntry('localhost:3000').siteKey, 'https://localhost:3000');
  assert.equal(parseWebsiteEntry('http://localhost:3000').siteKey, 'http://localhost:3000');
});

test('legacy Meet settings/plate migrate but audio consent does not enable camera gestures', () => {
  const state = migrateStoredState({ settings: { realTimeRemoval: false, snapDetection: true, snapSensitivity: .85 }, background: plate });
  assert.equal(state.profiles[meet].settings.realTimeRemoval, false);
  assert.equal(state.profiles[meet].settings.gestureSensitivity, .85);
  assert.equal(state.profiles[meet].settings.gestureDetection, false);
  assert.equal(state.profiles[meet].settings.characterStudio, false);
  assert.deepEqual(state.profiles[meet].background, plate);
  assert.equal(sanitizeSettings({ gestureDetection: 'yes', gestureSensitivity: NaN }).gestureDetection, false);
  assert.equal(sanitizeSettings({ gestureDetection: true, gestureCooldownMs: -1 }).gestureCooldownMs, 450);
  assert.equal(sanitizeSettings({}).characterStudio, false);
  assert.equal(sanitizeSettings({ characterStudio: true }).characterStudio, true);
  for (const value of [false, 'true', 1, null, {}, []]) {
    assert.equal(sanitizeSettings({ characterStudio: value }).characterStudio, false);
  }
});

test('explicit Character Studio opt-in survives stored-profile migration and frame configuration', async () => {
  const state = migrateStoredState({ siteProfiles: { [meet]: { enabled: true, settings: { characterStudio: true } } } });
  assert.equal(state.profiles[meet].settings.characterStudio, true);
  const env = environment({ siteProfiles: { [meet]: { enabled: true, settings: { characterStudio: true } } } });
  await env.manager.initialize();
  assert.equal((await env.manager.frameConfig(meet)).profile.settings.characterStudio, true);
});

test('host permission alone never enables processing or registration', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.initialize();
  const config = await env.manager.frameConfig(site);
  assert.equal(config.enabled, false);
  assert.equal(config.hostPermissionGranted, true);
  assert.equal(env.registered.size, 0);
});
test('stored enablement without host permission fails closed', async () => {
  const env = environment({ siteProfiles: { [site]: { enabled: true } } });
  assert.equal((await env.manager.frameConfig(site)).enabled, false);
  await env.manager.reconcile(); assert.equal(env.registered.size, 0);
  await assert.rejects(env.manager.command({ type: 'ENABLE_SITE', siteKey: site }), /permission/i);
});
test('explicit site enablement registers only that exact origin at document_start', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site });
  assert.equal((await env.manager.frameConfig(site)).enabled, true);
  assert.equal((await env.manager.frameConfig('https://other.video.example')).enabled, false);
  assert.equal((await env.manager.frameConfig(`${site}:8443`)).enabled, false);
  assert.equal(env.registered.size, 2);
  for (const script of env.registered.values()) {
    assert.deepEqual(script.matches, [pattern]); assert.equal(script.allFrames, false);
    assert.equal(script.runAt, 'document_start'); assert.equal(script.persistAcrossSessions, true);
  }
});
test('site disable deactivates current tabs while retaining settings and removing registrations', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site });
  await env.manager.command({ type: 'DISABLE_SITE', siteKey: site });
  assert.equal((await env.manager.frameConfig(site)).enabled, false);
  assert.equal(env.registered.size, 0);
  assert.ok(env.notices.some(({ message }) => message.type === 'POLICY_CHANGED' && message.siteKey === site));
});
test('global off gates Meet too and global on preserves a disabled site choice', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site });
  await env.manager.command({ type: 'SET_GLOBAL_ENABLED', enabled: false });
  assert.equal((await env.manager.frameConfig(meet)).enabled, false);
  assert.equal((await env.manager.frameConfig(site)).enabled, false);
  assert.equal(env.registered.size, 0);
  await env.manager.command({ type: 'DISABLE_SITE', siteKey: site });
  await env.manager.command({ type: 'SET_GLOBAL_ENABLED', enabled: true });
  assert.equal((await env.manager.frameConfig(meet)).enabled, true);
  assert.equal((await env.manager.frameConfig(site)).enabled, false);
});
test('Meet can be paused/removed without migration silently re-enabling it', async () => {
  const env = environment({ settings: { animations: false }, background: plate });
  await env.manager.command({ type: 'REMOVE_SITE', siteKey: meet });
  await env.manager.initialize();
  assert.equal((await env.manager.frameConfig(meet)).enabled, false);
  assert.equal((await env.manager.frameConfig(meet)).profile.background, null);
});
test('removing a site releases its permission, plates, registration and active policy', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site });
  await env.manager.frameCommand({ type: 'FRAME_BACKGROUND_CAPTURED', background: plate }, site);
  await env.manager.command({ type: 'REMOVE_SITE', siteKey: site });
  assert.equal((await env.manager.frameConfig(site)).profile, null);
  assert.equal(env.permissions.has(pattern), false); assert.equal(env.registered.size, 0);
});
test('permission revocation, including broad browser revocation, disables every affected profile', async () => {
  const env = environment(); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site }); env.permissions.delete(pattern);
  await env.manager.permissionsChanged();
  assert.equal((await env.manager.frameConfig(site)).profile.enabled, false);
  assert.equal(env.registered.size, 0);
});
test('stale removed registrations are reconciled but other extensions/unrelated IDs are untouched', async () => {
  const env = environment();
  env.registered.set('veyl-site-main-dead', { id: 'veyl-site-main-dead' });
  env.registered.set('other-feature', { id: 'other-feature' });
  await env.manager.reconcile();
  assert.deepEqual([...env.registered.keys()], ['other-feature']);
});
test('a site gets only its own profile; legacy Meet plate is not shared to another origin', async () => {
  const env = environment({ background: plate }); env.permissions.add(pattern);
  await env.manager.command({ type: 'ENABLE_SITE', siteKey: site });
  assert.equal((await env.manager.frameConfig(site)).profile.background, null);
  assert.deepEqual((await env.manager.frameConfig(meet)).profile.background, plate);
});
test('profile writes from two sites plus settings and background capture are serialized', async () => {
  const env = environment(); env.permissions.add(pattern); env.permissions.add('https://second.example:443/*');
  await Promise.all([env.manager.command({ type: 'ENABLE_SITE', siteKey: site }), env.manager.command({ type: 'ENABLE_SITE', siteKey: 'https://second.example' })]);
  await Promise.all([
    env.manager.command({ type: 'SAVE_SITE_SETTINGS', siteKey: site, settings: { animations: false, gestureDetection: true } }),
    env.manager.frameCommand({ type: 'FRAME_BACKGROUND_CAPTURED', background: plate }, site)
  ]);
  const current = await env.manager.frameConfig(site);
  assert.equal(current.profile.settings.animations, false); assert.equal(current.profile.settings.gestureDetection, true);
  assert.deepEqual(current.profile.background, plate);
  assert.equal((await env.manager.frameConfig('https://second.example')).enabled, true);
});
test('background deletion persists even on a disabled site with no open camera', async () => {
  const env = environment({ background: plate });
  await env.manager.command({ type: 'DISABLE_SITE', siteKey: meet });
  await env.manager.command({ type: 'DELETE_SITE_BACKGROUND', siteKey: meet });
  assert.equal((await env.manager.frameConfig(meet)).profile.background, null);
});
test('unenabled frames and invalid background data cannot write a plate', async () => {
  const env = environment();
  await assert.rejects(env.manager.frameCommand({ type: 'FRAME_BACKGROUND_CAPTURED', background: plate }, site), /disabled/);
  assert.equal(isBackgroundPlate({ ...plate, dataUrl: 'https://tracker.invalid/photo.jpg' }), false);
  assert.equal(isBackgroundPlate({ ...plate, dataUrl: 'data:image/svg+xml;base64,YWJj' }), false);
  assert.equal(isBackgroundPlate({ ...plate, width: Infinity }), false);
  assert.equal(isBackgroundPlate(plate), true);
});
test('failed script registration rolls back enablement rather than claiming the site is ready', async () => {
  const env = environment(); env.permissions.add(pattern);
  env.browser.scripting.registerContentScripts = async () => { throw new Error('unsupported registration'); };
  await assert.rejects(env.manager.command({ type: 'ENABLE_SITE', siteKey: site }), /unsupported/);
  assert.equal((await env.manager.frameConfig(site)).enabled, false);
});
