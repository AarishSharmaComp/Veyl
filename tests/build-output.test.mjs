import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { buildAndPublish } from '../scripts/build-output.mjs';

function fixture(t, previous = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'veyl-build-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = resolve(root, 'dist');
  const unrelated = resolve(root, `.dist-staging-${process.pid}`);
  mkdirSync(unrelated);
  writeFileSync(resolve(unrelated, 'user-file.txt'), 'keep this directory');
  if (previous) {
    mkdirSync(resolve(dist, 'nested'), { recursive: true });
    writeFileSync(resolve(dist, 'version.txt'), 'previous build');
    writeFileSync(resolve(dist, 'nested/old-only.txt'), 'previous asset');
  }
  return { root, dist, unrelated };
}

function prepare(staging) {
  mkdirSync(resolve(staging, 'nested'));
  writeFileSync(resolve(staging, 'version.txt'), 'new build');
  writeFileSync(resolve(staging, 'nested/new-only.txt'), 'new asset');
}

function assertPrevious(directory) {
  assert.equal(readFileSync(resolve(directory, 'version.txt'), 'utf8'), 'previous build');
  assert.equal(readFileSync(resolve(directory, 'nested/old-only.txt'), 'utf8'), 'previous asset');
  assert.equal(existsSync(resolve(directory, 'nested/new-only.txt')), false);
}

function assertClean({ root, dist, unrelated }) {
  assert.deepEqual(readdirSync(root).sort(), [basename(unrelated), ...(existsSync(dist) ? ['dist'] : [])].sort());
  assert.equal(readFileSync(resolve(unrelated, 'user-file.txt'), 'utf8'), 'keep this directory');
}

test('publishing replaces a nonempty dist and cleans only this build’s temporary output', async (t) => {
  const env = fixture(t);
  await buildAndPublish(env.dist, prepare);
  assert.equal(readFileSync(resolve(env.dist, 'version.txt'), 'utf8'), 'new build');
  assert.equal(readFileSync(resolve(env.dist, 'nested/new-only.txt'), 'utf8'), 'new asset');
  assert.equal(existsSync(resolve(env.dist, 'nested/old-only.txt')), false);
  assertClean(env);
});

test('a failed publish rename restores the complete previous dist', async (t) => {
  const env = fixture(t);
  const failure = Object.assign(new Error('simulated publish failure'), { code: 'EACCES' });
  let staging;
  await assert.rejects(buildAndPublish(env.dist, (directory) => {
    staging = directory;
    prepare(directory);
  }, {
    renameSync(from, to) {
      if (from === staging) throw failure;
      renameSync(from, to);
    }
  }), (error) => error === failure);
  assertPrevious(env.dist);
  assertClean(env);
});

test('a failed backup rename leaves the previous dist in place', async (t) => {
  const env = fixture(t);
  const failure = Object.assign(new Error('simulated backup failure'), { code: 'EACCES' });
  await assert.rejects(buildAndPublish(env.dist, prepare, {
    renameSync(from, to) {
      if (from === env.dist) throw failure;
      renameSync(from, to);
    }
  }), (error) => error === failure);
  assertPrevious(env.dist);
  assertClean(env);
});

test('a preparation or validation failure preserves dist and cleans partial staging output', async (t) => {
  const env = fixture(t);
  const failure = new Error('validation failed');
  await assert.rejects(buildAndPublish(env.dist, (staging) => {
    prepare(staging);
    throw failure;
  }), (error) => error === failure);
  assertPrevious(env.dist);
  assertClean(env);
});

test('publishing also works when there is no previous dist', async (t) => {
  const env = fixture(t, false);
  await buildAndPublish(env.dist, prepare);
  assert.equal(readFileSync(resolve(env.dist, 'version.txt'), 'utf8'), 'new build');
  assertClean(env);
});

test('a failed first publication leaves no partial dist or build-owned temporary directory', async (t) => {
  const env = fixture(t, false);
  const failure = Object.assign(new Error('simulated first publish failure'), { code: 'EACCES' });
  await assert.rejects(buildAndPublish(env.dist, prepare, {
    renameSync(from, to) {
      if (to === env.dist) throw failure;
      renameSync(from, to);
    }
  }), (error) => error === failure);
  assert.equal(existsSync(env.dist), false);
  assertClean(env);
});

test('if rollback also fails, the previous output is retained and its recovery path is reported', async (t) => {
  const env = fixture(t);
  const publicationFailure = new Error('simulated publish failure');
  const rollbackFailure = new Error('simulated rollback failure');
  let staging;
  let recoveryPath;
  await assert.rejects(buildAndPublish(env.dist, (directory) => {
    staging = directory;
    prepare(directory);
  }, {
    renameSync(from, to) {
      if (from === staging) throw publicationFailure;
      if (to === env.dist) {
        recoveryPath = from;
        throw rollbackFailure;
      }
      renameSync(from, to);
    }
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [publicationFailure, rollbackFailure]);
    assert.equal(error.cause, publicationFailure);
    assert.ok(error.message.includes(recoveryPath));
    return true;
  });
  assertPrevious(recoveryPath);
  assert.equal(existsSync(env.dist), false);
  assert.equal(readFileSync(resolve(env.unrelated, 'user-file.txt'), 'utf8'), 'keep this directory');
});
