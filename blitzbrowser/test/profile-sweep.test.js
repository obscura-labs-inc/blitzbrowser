// Unit test for the leaked Chrome profile sweep. Runs against the compiled output,
// so `npm run build` must run first (the `test` npm script does this).
//
//   npm test
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { orphanedProfileIds, sweepOrphanedProfiles } = require('../dist/services/profile-sweep.js');

async function makeRoot(ids) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-sweep-'));
  for (const id of ids) {
    await fs.mkdir(path.join(root, id, 'Default'), { recursive: true });
    await fs.writeFile(path.join(root, id, 'Local State'), '{}');
  }
  return root;
}

test('profiles without a live instance are orphans', () => {
  assert.deepEqual(orphanedProfileIds(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

test('with no live instances every profile is an orphan', () => {
  assert.deepEqual(orphanedProfileIds(['a', 'b'], []), ['a', 'b']);
});

test('sweep deletes orphaned profile folders and keeps live ones', async () => {
  const root = await makeRoot(['live-1', 'dead-1', 'dead-2']);
  await fs.writeFile(path.join(root, 'stray-file'), 'x');

  const removed = await sweepOrphanedProfiles(() => ['live-1'], root);

  assert.deepEqual(removed.sort(), ['dead-1', 'dead-2']);
  assert.deepEqual((await fs.readdir(root)).sort(), ['live-1', 'stray-file']);
  await fs.rm(root, { recursive: true, force: true });
});

test('sweep reads live instances after listing, so a just-created instance is kept', async () => {
  const root = await makeRoot(['new-1']);

  const removed = await sweepOrphanedProfiles(() => ['new-1'], root);

  assert.deepEqual(removed, []);
  assert.deepEqual(await fs.readdir(root), ['new-1']);
  await fs.rm(root, { recursive: true, force: true });
});

test('a missing profiles root is a no-op', async () => {
  const removed = await sweepOrphanedProfiles(() => [], path.join(os.tmpdir(), 'does-not-exist-profile-sweep'));

  assert.deepEqual(removed, []);
});
