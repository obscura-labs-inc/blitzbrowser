import * as fsPromise from 'fs/promises';
import * as path from 'path';

/**
 * Each browser instance keeps its Chrome profile in PROFILES_ROOT/<instance id> and
 * deletes it when the instance closes. A profile whose instance is no longer in the
 * pool was leaked (the container restarted mid-session, or a close died before its
 * delete), and nothing else will ever remove it. Left alone, thousands of these once
 * filled the disk and wedged the box.
 */
export const PROFILES_ROOT = '/home/pptruser/user-data';

export function orphanedProfileIds(profile_ids: string[], live_instance_ids: Iterable<string>): string[] {
  const live = new Set(live_instance_ids);
  return profile_ids.filter((id) => !live.has(id));
}

/**
 * Deletes every profile folder under `root` that does not belong to a live instance.
 * `liveInstanceIds` is read after listing the folder, so an instance created between
 * the two steps is still treated as live and its new folder is kept.
 */
export async function sweepOrphanedProfiles(
  liveInstanceIds: () => Iterable<string>,
  root: string = PROFILES_ROOT,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fsPromise.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return [];
    }
    throw e;
  }

  const orphans = orphanedProfileIds(entries, liveInstanceIds());

  // One undeletable folder must not stop the rest from being removed.
  const results = await Promise.allSettled(
    orphans.map((id) =>
      fsPromise.rm(path.join(root, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }),
    ),
  );

  return orphans.filter((_, i) => results[i].status === 'fulfilled');
}
