export const BROWSERS_FOLDER = '/blitzbrowser/browsers';

export interface BrowserVersionManager {

    get family(): string;

    isVersionInstalled(version: string): Promise<boolean>;

    isValidVersion(version: string): Promise<boolean>;

    installVersion(version: string): Promise<void>;

    loadVersions(): Promise<void>;

}