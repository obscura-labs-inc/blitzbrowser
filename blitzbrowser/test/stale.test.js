// Unit test for the idle-based staleness predicate. Runs against the compiled
// output, so `npm run build` must run first (the `test` npm script does this).
//
//   npm test
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { idleSeconds, isIdleStale } = require('../dist/services/stale.js');

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

test('an actively-driven instance is never stale', () => {
  // Traffic 2s ago, threshold 180s → live session, must survive.
  assert.equal(isIdleStale({ last_activity_at: at(2), connected_at: at(600) }, NOW, 180), false);
});

test('a long-connected instance that is still active survives', () => {
  // Connected 10 minutes ago but active 1s ago: connection age is irrelevant,
  // this is the exact bug we are fixing (age-based reaping killed live sessions).
  assert.equal(isIdleStale({ last_activity_at: at(1), connected_at: at(600) }, NOW, 180), false);
});

test('an idle instance past the threshold is stale', () => {
  assert.equal(isIdleStale({ last_activity_at: at(200), connected_at: at(600) }, NOW, 180), true);
});

test('idle exactly at the threshold is not yet stale (strictly greater)', () => {
  assert.equal(isIdleStale({ last_activity_at: at(180), connected_at: at(600) }, NOW, 180), false);
});

test('before any traffic, connect time is the idle reference', () => {
  // No activity yet (mid-preparation). Connected 5s ago → not stale at 180s;
  // connected 200s ago with no traffic → a stuck/leaked connect → stale.
  assert.equal(isIdleStale({ connected_at: at(5) }, NOW, 180), false);
  assert.equal(isIdleStale({ connected_at: at(200) }, NOW, 180), true);
});

test('a brand-new instance with no connect time is never reaped', () => {
  assert.equal(isIdleStale({}, NOW, 180), false);
  assert.equal(idleSeconds({}, NOW), null);
});

test('idleSeconds prefers last_activity_at over connected_at', () => {
  assert.equal(idleSeconds({ last_activity_at: at(30), connected_at: at(600) }, NOW), 30);
});
