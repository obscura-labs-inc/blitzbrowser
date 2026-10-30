// Unit test for the optional CloudWatch session heartbeat. Runs against the
// compiled output, so `npm run build` must run first (the `test` npm script does this).
//
//   npm test
//
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
const { SessionMetrics, SESSION_METRIC_NAME } = require('../dist/services/session-metrics.js');

const originalSend = CloudWatchClient.prototype.send;
afterEach(() => {
  CloudWatchClient.prototype.send = originalSend;
});

function captureSends() {
  const sent = [];
  CloudWatchClient.prototype.send = async function (command) {
    sent.push(command.input);
    return {};
  };
  return sent;
}

test('without a namespace the heartbeat is disabled and publishes nothing', () => {
  const sent = captureSends();
  const metrics = new SessionMetrics('');

  metrics.recordSessionStarted();

  assert.equal(metrics.enabled, false);
  assert.equal(sent.length, 0);
});

test('with a namespace a started session publishes one count datapoint', () => {
  const sent = captureSends();
  const metrics = new SessionMetrics('Passive/Scraper');

  metrics.recordSessionStarted();

  assert.equal(metrics.enabled, true);
  assert.deepEqual(sent, [
    {
      Namespace: 'Passive/Scraper',
      MetricData: [{ MetricName: SESSION_METRIC_NAME, Value: 1, Unit: 'Count' }],
    },
  ]);
});

test('a CloudWatch failure is swallowed, never thrown into the session', async () => {
  CloudWatchClient.prototype.send = async () => {
    throw new Error('AccessDenied');
  };
  const metrics = new SessionMetrics('Passive/Scraper');

  assert.doesNotThrow(() => metrics.recordSessionStarted());
  await new Promise((resolve) => setImmediate(resolve));
});
