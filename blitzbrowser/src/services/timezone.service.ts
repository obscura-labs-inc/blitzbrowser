import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";

@Injectable()
export class TimezoneService {

    private readonly logger = new Logger(TimezoneService.name);

    #default_timezone: Promise<string | undefined>;

    getDefaultTimezone(): Promise<string | undefined> {
        if (!this.#default_timezone) {
            this.#default_timezone = (async (): Promise<string | undefined> => {
                try {
                    const response = await fetch('http://ip-api.com/json?fields=timezone', { signal: AbortSignal.timeout(2000) });
                    return (await response.json()).timezone;
                } catch (e) {
                    this.logger.error('Error while getting default timezone.', e as Error);
                    return undefined;
                }
            })();
        }

        return this.#default_timezone;
    }

    async getProxyTimezone(proxy_url: string): Promise<string> {
        try {
            const url = new URL(proxy_url);
            const response = await axios.get('http://ip-api.com/json?fields=timezone', {
                timeout: 2000,
                proxy: {
                    protocol: url.protocol,
                    host: url.hostname,
                    port: parseInt(url.port),
                    auth: {
                        username: url.username,
                        password: url.password,
                    }
                }
            });

            return response.data.timezone;
        } catch (e) {
            this.logger.error(`Error while getting timezone.`, e);
        }
    }

}