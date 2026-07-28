import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  isFolderAvailable,
  readEntryMetadata,
  type MetadataResult,
} from "./metadata.js";
import {
  locationKey,
  parseSelectedPath,
} from "./paths.js";
import { Registry } from "./registry.js";
import type { ActionLauncher } from "./launcher.js";
import type { FolderPicker } from "./picker.js";
import {
  type ActionName,
  type ClientEntry,
  type EntryDetails,
  type EntryLocation,
  type MetadataStatus,
  type RegistryData,
  type StoredEntry,
  TAG_ICON_PRIORITY,
} from "./types.js";

export class EntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Entry not found: ${entryId}`);
  }
}

export class EntryUnavailableError extends Error {
  constructor(entryId: string) {
    super(`Entry is unavailable: ${entryId}`);
  }
}

export interface RegistrationResult {
  entry: ClientEntry;
  created: boolean;
}

export class EntryService {
  constructor(
    private readonly registry: Registry,
    private readonly picker: FolderPicker,
    private readonly launcher: ActionLauncher,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  async initialize(): Promise<void> {
    await this.registry.load();
  }

  async listEntries(): Promise<ClientEntry[]> {
    const data = await this.registry.load();
    let registryChanged = false;

    const entries = await Promise.all(
      data.entries.map(async (entry) => {
        const refreshed = await this.refreshEntry(entry);
        if (refreshed.changed) {
          entry.lastKnown = refreshed.entry.lastKnown;
          registryChanged = true;
        }
        return toClientEntry(refreshed.entry, refreshed.available);
      }),
    );

    if (registryChanged) {
      await this.registry.save(data);
    }

    return entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  }

  async registerFromPicker(): Promise<RegistrationResult | null> {
    const selectedPath = await this.picker.pick();
    if (selectedPath === null) {
      return null;
    }

    const location = parseSelectedPath(selectedPath);
    const data = await this.registry.load();
    const duplicate = findByLocation(data, location);
    if (duplicate) {
      const refreshed = await this.refreshEntry(duplicate);
      if (refreshed.changed) {
        duplicate.lastKnown = refreshed.entry.lastKnown;
        await this.registry.save(data);
      }
      return {
        entry: toClientEntry(refreshed.entry, refreshed.available),
        created: false,
      };
    }

    if (!(await isFolderAvailable(location))) {
      throw new Error("The selected folder is no longer available.");
    }

    const id = randomUUID();
    const metadata = await readEntryMetadata(location, this.warn);
    await this.syncCachedIcon(id, metadata, false);

    const entry: StoredEntry = {
      id,
      location,
      lastKnown: metadata.presentation,
    };
    data.entries.push(entry);
    await this.registry.save(data);

    return {
      entry: toClientEntry(entry, true),
      created: true,
    };
  }

  async performAction(entryId: string, action: ActionName): Promise<void> {
    const data = await this.registry.load();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }
    if (!(await isFolderAvailable(entry.location))) {
      throw new EntryUnavailableError(entryId);
    }

    await this.launcher.launch(action, entry.location);
  }

  async getEntryDetails(entryId: string): Promise<EntryDetails> {
    const data = await this.registry.load();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }

    const refreshed = await this.refreshEntry(entry);
    if (refreshed.changed) {
      entry.lastKnown = refreshed.entry.lastKnown;
      await this.registry.save(data);
    }

    return toEntryDetails(
      refreshed.entry,
      refreshed.available,
      refreshed.metadataStatus,
    );
  }

  async removeEntry(entryId: string): Promise<void> {
    const data = await this.registry.load();
    const entryIndex = data.entries.findIndex(
      (candidate) => candidate.id === entryId,
    );
    if (entryIndex === -1) {
      throw new EntryNotFoundError(entryId);
    }

    data.entries.splice(entryIndex, 1);
    await this.registry.save(data);
    try {
      await this.registry.removeCachedIcon(entryId);
    } catch (error) {
      this.warn(
        `Entry ${entryId} was removed, but its cached icon could not be removed: ${errorMessage(error)}`,
      );
    }
  }

  async readCachedIcon(entryId: string): Promise<Buffer> {
    const data = await this.registry.load();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }
    if (!entry.lastKnown.hasCustomIcon) {
      throw new EntryNotFoundError(entryId);
    }

    try {
      return await readFile(this.registry.iconPath(entryId));
    } catch {
      throw new EntryNotFoundError(entryId);
    }
  }

  private async refreshEntry(
    entry: StoredEntry,
  ): Promise<{
    entry: StoredEntry;
    available: boolean;
    changed: boolean;
    metadataStatus: MetadataStatus;
  }> {
    const available = await isFolderAvailable(entry.location);
    if (!available) {
      return {
        entry,
        available: false,
        changed: false,
        metadataStatus: "folder_unavailable",
      };
    }

    const metadata = await readEntryMetadata(entry.location, this.warn);
    await this.syncCachedIcon(
      entry.id,
      metadata,
      entry.lastKnown.hasCustomIcon,
    );

    const changed = !isDeepStrictEqual(
      metadata.presentation,
      entry.lastKnown,
    );
    return {
      entry: changed
        ? { ...entry, lastKnown: metadata.presentation }
        : entry,
      available: true,
      changed,
      metadataStatus: metadata.metadataStatus,
    };
  }

  private async syncCachedIcon(
    entryId: string,
    metadata: MetadataResult,
    previouslyHadIcon: boolean,
  ): Promise<void> {
    if (metadata.customIcon) {
      await this.registry.cacheIcon(entryId, metadata.customIcon);
    } else if (previouslyHadIcon) {
      await this.registry.removeCachedIcon(entryId);
    }
  }
}

function findByLocation(
  data: RegistryData,
  location: EntryLocation,
): StoredEntry | undefined {
  const key = locationKey(location);
  return data.entries.find((entry) => locationKey(entry.location) === key);
}

function toClientEntry(entry: StoredEntry, available: boolean): ClientEntry {
  return {
    id: entry.id,
    name: entry.lastKnown.name,
    tags: [...entry.lastKnown.tags],
    defaultAction: entry.lastKnown.defaultAction,
    available,
    hasCustomIcon: entry.lastKnown.hasCustomIcon,
  };
}

function toEntryDetails(
  entry: StoredEntry,
  available: boolean,
  metadataStatus: MetadataStatus,
): EntryDetails {
  const tags = new Set(entry.lastKnown.tags);
  const tagIcon = TAG_ICON_PRIORITY.find((tag) => tags.has(tag));

  return {
    ...toClientEntry(entry, available),
    environment:
      entry.location.kind === "windows"
        ? { kind: "windows" }
        : {
            kind: "wsl",
            distribution: entry.location.distribution,
          },
    location: entry.location.path,
    metadataStatus,
    iconSource: entry.lastKnown.hasCustomIcon
      ? { kind: "custom" }
      : tagIcon
        ? { kind: "tag", tag: tagIcon }
        : { kind: "none" },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
