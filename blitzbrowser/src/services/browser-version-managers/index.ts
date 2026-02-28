export const BROWSERS_FOLDER = '/blitzbrowser/browsers';

export type Version = 'latest' | 'default' | (string & {});

export interface BrowserVersionManager {

    get family(): string;

    getExecutablePath(version: Version): string;

    isVersionInstalled(version: Version): Promise<boolean>;

    isValidVersion(version: Version): Promise<boolean>;

    installVersion(version: Version): Promise<void>;

    loadVersions(): Promise<void>;

}