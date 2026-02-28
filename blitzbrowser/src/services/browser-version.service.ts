import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ChromeVersionManager } from "./browser-version-managers/chrome-version.manager";
import { BrowserVersionManager, Version } from "./browser-version-managers";

@Injectable()
export class BrowserVersionService implements OnModuleInit {

    readonly #logger = new Logger(BrowserVersionService.name);

    readonly #chrome_version_manager = new ChromeVersionManager();

    readonly #browser_version_managers: Map<string, BrowserVersionManager> = new Map();

    @Interval(4 * 60 * 60 * 1000) // 4 hours
    async onModuleInit() {
        await this.#chrome_version_manager.loadVersions();

        this.#browser_version_managers.set(this.#chrome_version_manager.family, this.#chrome_version_manager);
    }

    getExecutablePath(family: string, version: Version): string {
        return this.#getBrowserVersionManager(family).getExecutablePath(version);
    }

    isValidVersion(family: string, version: Version): Promise<boolean> {
        return this.#getBrowserVersionManager(family).isValidVersion(version);
    }

    installVersion(family: string, version: Version) {
        return this.#getBrowserVersionManager(family).installVersion(version);
    }

    isVersionInstalled(family: string, version: Version) {
        return this.#getBrowserVersionManager(family).isVersionInstalled(version);
    }

    #getBrowserVersionManager(family: string) {
        const browser_version_manager = this.#browser_version_managers.get(family);

        if (!browser_version_manager) {
            throw `Browser family '${family}' not supported.`;
        }

        return browser_version_manager;
    }

}