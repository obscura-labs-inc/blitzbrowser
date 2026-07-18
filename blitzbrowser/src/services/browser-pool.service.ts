import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BrowserInstance } from 'src/components/browser-instance.component';
import * as EventEmitter from 'events';
import { ModuleRef } from '@nestjs/core';
import { MaxBrowserReachedError } from 'src/errors/max-browser-reached.error';
import { idleSeconds, isIdleStale } from 'src/services/stale';

type PoolServiceEvents = {
  browser_instance_created: [BrowserInstance];
}

export interface BrowserPoolStatus {
  id: string;
  started_at: string;
  max_browser_instances: number;
  tags: { [key: string]: string; };
}

@Injectable()
export class BrowserPoolService extends EventEmitter<PoolServiceEvents> implements OnModuleInit {

  private readonly logger = new Logger(BrowserPoolService.name);

  readonly #id: string = crypto.randomUUID();
  readonly #started_at = new Date().toISOString();
  readonly #tags: { [key: string]: string; } = {};

  readonly max_browser_instances = parseInt(process.env.MAX_BROWSER_INSTANCES || '99');

  readonly #browser_instances = new Map<string, BrowserInstance>();

  #sigterm_received: boolean = false;

  constructor(
    private readonly module_ref: ModuleRef,
  ) {
    super();

    (process.env.TAGS || '').split(',').forEach(tag => {
      const [key, value] = tag.split('=');

      this.#tags[key] = value;
    })
  }

  get status(): BrowserPoolStatus {
    return {
      id: this.#id,
      started_at: this.#started_at,
      max_browser_instances: this.max_browser_instances,
      tags: this.#tags
    };
  }

  get id() {
    return this.#id;
  }

  get started_at() {
    return this.#started_at;
  }

  get tags() {
    return this.#tags;
  }

  get sigterm_received() {
    return this.#sigterm_received;
  }

  get nb_browser_instances_alive() {
    return this.#browser_instances.size;
  }

  get browser_instances() {
    return [...this.#browser_instances.values()]
  }

  async onModuleInit() {
    process.on('SIGTERM', () => {
      this.logger.log('SIGTERM received');
      this.shutdown();
    });
  }

  getBrowserInstanceById(id: string): BrowserInstance | undefined {
    return this.#browser_instances.get(id);
  }

  createBrowserInstance(id: string = crypto.randomUUID()) {
    if (this.sigterm_received) {
      this.logger.log(`Can't create new browser instance. Sigterm has been received.`);
      return;
    }

    if(this.#browser_instances.size === this.max_browser_instances) {
      throw new MaxBrowserReachedError();
    }

    const browser_instance = new BrowserInstance(id, this.module_ref);

    this.logger.log(`Created browser instance ${browser_instance.id}.`);

    browser_instance.on('terminated', () => {
      this.logger.log(`Browser instance ${browser_instance.id} terminated. Removing from pool.`);
      this.#browser_instances.delete(browser_instance.id);
    });

    this.#browser_instances.set(browser_instance.id, browser_instance);

    this.emit('browser_instance_created', browser_instance);

    return browser_instance;
  }

  async closeStaleInstances(max_age_seconds: number): Promise<string[]> {
    const now = Date.now();

    // Reap by IDLE time, not connection age: an instance being actively driven
    // over CDP keeps refreshing last_activity_at, so a live submission is never
    // torn down mid-flow. Only an instance that has gone silent past max_age
    // (a leaked/half-open connection whose client is gone) is stale.
    const stale: BrowserInstance[] = [];
    for (const instance of this.#browser_instances.values()) {
      if (isIdleStale(instance.status, now, max_age_seconds)) {
        const idle = Math.floor(idleSeconds(instance.status, now) ?? 0);
        this.logger.log(`Closing stale instance ${instance.id} (idle=${idle}s)`);
        stale.push(instance);
      }
    }

    // Close concurrently and time-box each close(). A single wedged Chrome whose
    // close() never resolves (it ignores SIGTERM, or an S3 upload inside close()
    // hangs) must not block the other closes or hang this endpoint. That once left
    // the systemd oneshot reaper stuck in "activating" for weeks, so the pool
    // saturated with stale instances and every session hit "Browser is dead".
    const CLOSE_TIMEOUT_MS = 20_000;
    const closed: string[] = [];

    await Promise.allSettled(
      stale.map(
        (instance) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.logger.error(
                `Stale instance ${instance.id} did not close within ${CLOSE_TIMEOUT_MS}ms; abandoning wait`,
              );
              resolve();
            }, CLOSE_TIMEOUT_MS);

            instance.close().then(
              () => {
                clearTimeout(timer);
                closed.push(instance.id);
                resolve();
              },
              (e) => {
                clearTimeout(timer);
                this.logger.error(`Error closing stale instance ${instance.id}: ${e?.message ?? e}`);
                resolve();
              },
            );
          }),
      ),
    );

    return closed;
  }

  async shutdown() {
    if (this.#sigterm_received) {
      return;
    }

    this.#sigterm_received = true;

    this.logger.log('Shutdown requested.');

    for (const browser_instance of this.#browser_instances.values()) {
      if (browser_instance.in_use) {
        continue;
      }

      await browser_instance.close();
    }

    setInterval(async () => {
      if (this.#browser_instances.size !== 0) {
        this.logger.log(`Waiting for ${this.#browser_instances.size} browser instance(s) to close.`);
        return;
      }

      this.logger.log(`All browser instances are closed.`);

      process.exit(0);
    }, 200);
  }

}
