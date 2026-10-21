import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function buildAndPublish(dist, prepare, {
  mkdirSync = fs.mkdirSync,
  mkdtempSync = fs.mkdtempSync,
  renameSync = fs.renameSync,
  rmSync = fs.rmSync
} = {}) {
  dist = resolve(dist);
  const temporary = mkdtempSync(resolve(dirname(dist), '.dist-staging-'));
  const staging = resolve(temporary, 'next');
  const previous = resolve(temporary, 'previous');
  let preservePrevious = false;
  try {
    mkdirSync(staging);
    await prepare(staging);

    // These are staged renames, not an atomic exchange. Retain the old output for rollback.
    try {
      renameSync(dist, previous);
      preservePrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      renameSync(staging, dist);
    } catch (error) {
      if (preservePrevious) {
        try {
          renameSync(previous, dist);
          preservePrevious = false;
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError],
            `Build publication and rollback failed; previous output is preserved at ${previous}`,
            { cause: error });
        }
      }
      throw error;
    }
    preservePrevious = false;
  } finally {
    if (!preservePrevious) rmSync(temporary, { recursive: true, force: true });
  }
}
