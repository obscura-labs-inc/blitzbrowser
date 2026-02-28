import { spawn } from "child_process";
import { BROWSERS_FOLDER, BrowserVersionManager, Version } from ".";
import * as fs from 'fs-extra';
import { Logger } from "@nestjs/common";
import puppeteer from "puppeteer";

interface ChromeTestingVersions {
    timestamp: string;
    versions: {
        version: string;
        revision: string;
    }[];
}

export class ChromeVersionManager implements BrowserVersionManager {

    readonly #logger = new Logger(ChromeVersionManager.name);

    #chrome_versions: Set<string> = new Set();

    #latest_version: string = '';

    readonly #version_install_promises: Map<string, Promise<void>> = new Map();

    readonly family = 'chrome';

    getExecutablePath(version: Version): string {
        if (version === 'default') {
            return puppeteer.executablePath();
        }

        if (version === 'latest') {
            return this.getExecutablePath(this.#latest_version);
        }

        return `${BROWSERS_FOLDER}/chrome/linux-${version}/chrome-linux64/chrome`;
    }

    async isVersionInstalled(version: Version): Promise<boolean> {
        return fs.exists(this.getExecutablePath(version));
    }

    installVersion(version: Version): Promise<void> {
        if (version === 'default') {
            return;
        }

        if (version === 'latest') {
            return this.installVersion(this.#latest_version);
        }

        if (this.#version_install_promises.has(version)) {
            this.#logger.log(`Version ${version} is already installing.`);
            return this.#version_install_promises.get(version);
        }

        this.#logger.log(`Installing version ${version}`);

        const version_install_promise = new Promise<void>((res, rej) => {
            const process = spawn(`tini`, ['-s', `--`, `npx`, `@puppeteer/browsers`, `install`, `chrome@${version}`, `--path`, BROWSERS_FOLDER]);

            process.on('exit', code => {
                this.#version_install_promises.delete(version);

                if (code === 0) {
                    this.#logger.log(`Installed version ${version}.`);
                    res(undefined);
                } else {
                    rej(`Error while downloading version ${version}`);
                }
            })
        });

        this.#version_install_promises.set(version, version_install_promise);

        return version_install_promise;
    }

    async isValidVersion(version: Version): Promise<boolean> {
        if (version === 'latest' || version === 'default') {
            return true;
        }

        return this.#chrome_versions.has(version);
    }

    async loadVersions(): Promise<void> {
        const chrome_testing_versions: ChromeTestingVersions = await (await fetch('https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json')).json();

        this.#chrome_versions = new Set(chrome_testing_versions.versions.filter(v => {
            const args = v.version.split('.');

            return parseInt(args[0]) >= 116; // Versions before 116 are not working
        }).map(v => v.version));
        this.#latest_version = chrome_testing_versions.versions[chrome_testing_versions.versions.length - 1].version;
    }

}