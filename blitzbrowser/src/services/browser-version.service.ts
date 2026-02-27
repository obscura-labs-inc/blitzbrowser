import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ChromeVersionManager } from "./browser-version-managers/chrome-version.manager";

@Injectable()
export class BrowserVersionService implements OnModuleInit {

    readonly #logger = new Logger(BrowserVersionService.name);

    readonly #chrome_version_manager = new ChromeVersionManager();

    @Interval(4 * 60 * 60 * 1000) // 4 hours
    async onModuleInit() {
        await this.#chrome_version_manager.loadVersions();

        const version = '146.0.7680.0';

        this.#logger.log(`Is version valid: ${await this.#chrome_version_manager.isValidVersion(version)}`);
        this.#logger.log(`Is version installed: ${await this.#chrome_version_manager.isVersionInstalled(version)}`);
        await Promise.all([
            this.#chrome_version_manager.installVersion(version),
            this.#chrome_version_manager.installVersion(version),
            this.#chrome_version_manager.installVersion(version)
        ])
        this.#logger.log(`Is version installed: ${await this.#chrome_version_manager.isVersionInstalled(version)}`);
    }

    async hasVersionInstalled(family: string, version: string) {
    }

}