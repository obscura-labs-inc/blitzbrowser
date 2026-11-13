import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BrowserInstance, ConnectionOptions, ConnectionOptionsEvent } from 'src/components/browser-instance.component';
import { BrowserPoolService } from 'src/services/browser-pool.service';
import { WebSocket } from 'ws';
import z from 'zod';
import { Message, Tunnel } from '@blitzbrowser/tunnel';
import { MaxBrowserReachedError } from 'src/errors/max-browser-reached.error';
import { BrowserVersionService } from 'src/services/browser-version.service';
import { SessionMetrics } from 'src/services/session-metrics';

// Per-connection CONNTRACE logging is verbose debug tracing, off unless CONNTRACE=1.
const CONNTRACE_ENABLED = process.env.CONNTRACE === '1' || process.env.CONNTRACE === 'true';

export const PROXY_URL_QUERY_PARAM = 'proxyUrl';
export const TIMEZONE_QUERY_PARAM = 'timezone';
export const USER_DATA_ID_QUERY_PARAM = 'userDataId';
export const USER_DATA_READ_ONLY_QUERY_PARAM = 'userDataReadOnly';
export const LIVE_VIEW_QUERY_PARAM = 'liveView';
export const BROWSER_FAMILY_QUERY_PARAM = 'browserFamily';
export const BROWSER_VERSION_QUERY_PARAM = 'browserVersion';

const ConnectionOptionQueryParams = z.object({
  proxy_url: z.url().optional(),
  timezone: z.string().optional(),
  user_data_id: z.string().optional(),
  user_data_read_only: z.boolean().optional().default(false),
  live_view: z.boolean().optional().default(false),
  browser_family: z.string().optional().default('chrome'),
  browser_version: z.string().optional().default('default'),
});

type ConnectionOptionQueryParams = z.infer<typeof ConnectionOptionQueryParams>;

@Injectable()
export class CDPWebSocketGateway implements OnModuleDestroy {

  private static readonly WAITING_BROWSER_TIMEOUT_MS = 10_000;

  static readonly INTERNAL_SERVER_ERROR_CODE = 4000;
  static readonly BAD_REQUEST_CODE = 4002;
  static readonly NO_BROWSER_INSTANCE_AVAILABLE = 4003;

  readonly #logger = new Logger(CDPWebSocketGateway.name);

  constructor(
    private readonly browser_pool_service: BrowserPoolService,
    private readonly browser_version_service: BrowserVersionService,
  ) { }

  onModuleDestroy() {
    this.browser_pool_service.shutdown();
  }

  async connectCDP(cdp_websocket_client: WebSocket, url: URL) {
    const conntrace_cid = url.searchParams.get('cid') ?? '-';
    const conntrace_t0 = Date.now();
    this.#conntrace(`cid=${conntrace_cid} event=connectCDP_entry`);
    let tunnel: Tunnel;

    try {
      const parsed_connection_options = this.#parseConnectionOptionQueryParams(url);

      if (!parsed_connection_options.success) {
        this.#conntrace(`cid=${conntrace_cid} event=parse_fail`);
        cdp_websocket_client.close(CDPWebSocketGateway.BAD_REQUEST_CODE, parsed_connection_options.error.message.trim());
        return;
      }

      tunnel = new Tunnel();

      tunnel.on('message', message => {
        if (message.channel_id === BrowserInstance.CDP_CHANNEL_ID) {
          cdp_websocket_client.send(message.data.toString('utf8'), { binary: false });
        }
      });

      tunnel.once('closed', () => {
        cdp_websocket_client.close();
      })

      cdp_websocket_client.on('message', message => {
        tunnel.receiveMessage(Message.of(BrowserInstance.CDP_CHANNEL_ID, message.toString('utf8')));
      });

      const { browser_family, browser_version } = parsed_connection_options.data;

      try {
        if (await this.browser_version_service.isValidVersion(browser_family, browser_version)) {
          if (!await this.browser_version_service.isVersionInstalled(browser_family, browser_version)) {
            await this.browser_version_service.installVersion(browser_family, browser_version);
          }
        } else {
          throw `Invalid browser version.`;
        }
      } catch (e) {
        this.#logger.error(`Error while checking browser version: ${e}`);
        cdp_websocket_client.close(CDPWebSocketGateway.BAD_REQUEST_CODE, typeof e === 'string' ? e : 'Error with browser version manager.');
        return;
      }

      this.#conntrace(`cid=${conntrace_cid} event=getinstance_start waited_ms=${Date.now() - conntrace_t0}`);
      const browser_instance: BrowserInstance = await this.#getBrowserInstance();
      this.#conntrace(`cid=${conntrace_cid} event=got_instance id=${browser_instance.id} waited_ms=${Date.now() - conntrace_t0}`);

      const ping_interval_id = setInterval(() => {
        cdp_websocket_client.ping();
      }, 3000);

      // A pong means the client is still connected and responsive, so the
      // instance counts as active even when no CDP commands are in flight (e.g.
      // the client is blocked waiting on a captcha solver). Keeps the idle reaper
      // from tearing down a live-but-quiet session.
      cdp_websocket_client.on('pong', () => {
        browser_instance.noteClientAlive();
      });

      cdp_websocket_client.on('close', () => {
        clearInterval(ping_interval_id);
        tunnel.close();
      });

      cdp_websocket_client.on('error', err => {
        this.#logger.error(`Error with cdp websocket.`, err?.stack || err);
      });

      browser_instance.connectTunnel(tunnel);

      tunnel.receiveMessage(Message.of(BrowserInstance.EVENT_CHANNEL_ID, JSON.stringify({
        type: 'CONNECTION_OPTIONS',
        options: {
          proxy_url: parsed_connection_options.data.proxy_url,
          timezone: parsed_connection_options.data.timezone,
          user_data_id: parsed_connection_options.data.user_data_id,
          user_data_read_only: parsed_connection_options.data.user_data_read_only,
          vnc_enabled: parsed_connection_options.data.live_view === true,
          browser_executable_path: this.browser_version_service.getExecutablePath(browser_family, browser_version),
        } satisfies ConnectionOptions
      } satisfies ConnectionOptionsEvent)));

      this.#conntrace(`cid=${conntrace_cid} event=ready id=${browser_instance.id} total_ms=${Date.now() - conntrace_t0}`);
      this.#logger.log('Sent connection options');
    } catch (e) {
      if (e instanceof MaxBrowserReachedError) {
        this.#conntrace(`cid=${conntrace_cid} event=maxreached_4003 waited_ms=${Date.now() - conntrace_t0}`);
        SessionMetrics.shared.recordAcquisitionTimeout();
        // Close the client with 4003 before tunnel.close(): the tunnel 'closed' handler also
        // closes the client socket with its default code, so closing here first is what actually
        // delivers 4003 to the client and lets it tell pool backpressure apart from a real crash.
        cdp_websocket_client.close(CDPWebSocketGateway.NO_BROWSER_INSTANCE_AVAILABLE, 'No browser instance available.');
        tunnel.close();
        return;
      }

      this.#conntrace(`cid=${conntrace_cid} event=error ${e?.message ?? e}`);
      this.#logger.error(`Error while handling client websocket.`, e?.stack || e)

      cdp_websocket_client.close(CDPWebSocketGateway.INTERNAL_SERVER_ERROR_CODE, e?.stack || e);
      return;
    }
  }

  #conntrace(message: string) {
    if (CONNTRACE_ENABLED) {
      this.#logger.log(`CONNTRACE ${message}`);
    }
  }

  async #getBrowserInstance(): Promise<BrowserInstance> {
    const start = Date.now();

    while (start + CDPWebSocketGateway.WAITING_BROWSER_TIMEOUT_MS > Date.now()) {
      try {
        const browser_instance = this.browser_pool_service.createBrowserInstance();

        if (browser_instance) {
          return browser_instance;
        }
      } catch (e) {
        if (e instanceof MaxBrowserReachedError) {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          continue;
        } else {
          throw e;
        }
      }
    }

    throw new MaxBrowserReachedError();
  }

  #parseConnectionOptionQueryParams(url: URL) {
    return ConnectionOptionQueryParams.safeParse({
      timezone: this.getQueryParamValue(TIMEZONE_QUERY_PARAM, url),
      proxy_url: this.getQueryParamValue(PROXY_URL_QUERY_PARAM, url),
      user_data_id: this.getQueryParamValue(USER_DATA_ID_QUERY_PARAM, url),
      user_data_read_only: this.getQueryParamValue(USER_DATA_READ_ONLY_QUERY_PARAM, url)?.toLowerCase() === 'true',
      live_view: this.getQueryParamValue(LIVE_VIEW_QUERY_PARAM, url)?.toLowerCase() === 'true',
      browser_family: this.getQueryParamValue(BROWSER_FAMILY_QUERY_PARAM, url),
      browser_version: this.getQueryParamValue(BROWSER_VERSION_QUERY_PARAM, url),
    });
  }

  private getQueryParamValue(param: string, url: URL) {
    return url.searchParams.has(param) ? url.searchParams.get(param) : undefined;
  }

}