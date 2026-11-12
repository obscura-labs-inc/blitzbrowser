import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@nestjs/common';

/**
 * Optional CloudWatch heartbeat for browser sessions.
 *
 * Enabled only when CLOUDWATCH_METRICS_NAMESPACE is set. Each session publishes one
 * `BrowserSessionsStarted` datapoint the moment Chrome is up and its CDP connection
 * opens, so an alarm on "no sessions for N hours" catches a box that can no longer
 * start browsers (full disk, saturated pool) or callers that stopped sending work.
 * It fires at start rather than at close so a session whose teardown hangs still
 * counts. Credentials and region come from the standard AWS SDK chain (instance
 * role via IMDS, AWS_REGION).
 */
export const SESSION_METRIC_NAME = 'BrowserSessionsStarted';
export const INSTANCE_DEATH_METRIC_NAME = 'BrowserInstanceDeaths';

export class SessionMetrics {
  static #instance: SessionMetrics | undefined;

  readonly #logger = new Logger(SessionMetrics.name);
  readonly #namespace: string | undefined;
  readonly #client: CloudWatchClient | undefined;

  constructor(namespace = process.env.CLOUDWATCH_METRICS_NAMESPACE) {
    this.#namespace = namespace || undefined;
    this.#client = this.#namespace ? new CloudWatchClient({}) : undefined;
  }

  static get shared(): SessionMetrics {
    return (SessionMetrics.#instance ??= new SessionMetrics());
  }

  get enabled() {
    return this.#client !== undefined;
  }

  /** Fire-and-forget: a CloudWatch failure must never affect a browser session. */
  recordSessionStarted() {
    if (!this.#client) {
      return;
    }

    this.#client
      .send(
        new PutMetricDataCommand({
          Namespace: this.#namespace,
          MetricData: [{ MetricName: SESSION_METRIC_NAME, Value: 1, Unit: 'Count' }],
        }),
      )
      .catch((e) => {
        this.#logger.error(`Failed to publish ${SESSION_METRIC_NAME}: ${e?.message ?? e}`);
      });
  }

  /**
   * Fire-and-forget: one datapoint per instance death, tagged by Reason so an alarm can
   * fire on abnormal deaths (process_exit / reaped_stale / cdp_terminated) and a dashboard
   * can chart the mix. The parameterized process_exit(code=..,sig=..) reason is collapsed
   * to a stable "process_exit" dimension so metric cardinality stays bounded.
   */
  recordInstanceDeath(reason: string) {
    if (!this.#client) {
      return;
    }

    const dimension = reason.startsWith('process_exit') ? 'process_exit' : reason;

    this.#client
      .send(
        new PutMetricDataCommand({
          Namespace: this.#namespace,
          MetricData: [{
            MetricName: INSTANCE_DEATH_METRIC_NAME,
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'Reason', Value: dimension }],
          }],
        }),
      )
      .catch((e) => {
        this.#logger.error(`Failed to publish ${INSTANCE_DEATH_METRIC_NAME}: ${e?.message ?? e}`);
      });
  }
}
