import { spawn } from "child_process";
import { BROWSERS_FOLDER, BrowserVersionManager } from ".";
import * as fs from 'fs-extra';

interface ChromeTestingVersions {
    timestamp: string;
    versions: {
        version: string;
        revision: string;
    }[];
}

export class ChromeVersionManager implements BrowserVersionManager {

    #chrome_versions: Set<string> = new Set();

    readonly #version_install_promises: Map<string, Promise<void>> = new Map();

    readonly family = 'chrome';

    async isVersionInstalled(version: string): Promise<boolean> {
        return fs.exists(`${BROWSERS_FOLDER}/chrome/linux-${version}/chrome-linux64/chrome`);
    }

    installVersion(version: string): Promise<void> {
        if (this.#version_install_promises.has(version)) {
            console.log('installation in progress');
            return this.#version_install_promises.get(version);
        }

        console.log('installing');

        const version_install_promise = new Promise<void>((res, rej) => {
            const process = spawn(`tini`, ['-s', `--`, `npx`, `@puppeteer/browsers`, `install`, `chrome@${version}`, `--path`, BROWSERS_FOLDER], {
                stdio: 'pipe'
            });

            process.on('exit', code => {
                this.#version_install_promises.delete(version);
                
                if (code === 0) {
                    res(undefined);
                } else {
                    rej(`Error while downloading version ${version}`);
                }
            })
        });

        this.#version_install_promises.set(version, version_install_promise);

        return version_install_promise;
    }

    async isValidVersion(version: string): Promise<boolean> {
        return this.#chrome_versions.has(version);
    }

    async loadVersions(): Promise<void> {
        const chrome_testing_versions: ChromeTestingVersions = await (await fetch('https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json')).json();

        this.#chrome_versions = new Set(chrome_testing_versions.versions.map(v => v.version));
    }

}