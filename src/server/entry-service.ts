import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { mapConcurrent } from "./concurrency.js";
import { inspectIntegration } from "./integration-inspector.js";
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
import {
  ENTRY_ICON_COLOR,
  ICON_NORMALIZER_VERSION,
  MAX_ICON_BYTES,
  normalizeEntryIcon,
} from "./svg-normalizer.js";
import {
  actionCommand,
  type ActionLauncher,
  type LaunchCommand,
} from "./launcher.js";
import type { FolderPicker } from "./picker.js";
import type { SessionManager } from "./session-manager.js";
import {
  type ActionName,
  type BuiltInActionName,
  type ClientEntry,
  type EntryDetails,
  type EntryLocation,
  type IntegrationInspection,
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

export class InvalidEntryPathError extends Error {}

export class SelectedFolderUnavailableError extends Error {
  constructor() {
    super("The selected folder is not available.");
  }
}

export class InvalidPinOrderError extends Error {
  constructor() {
    super("Pinned Entry order does not match the registry.");
  }
}

export class ActionNotFoundError extends Error {
  constructor(action: string) {
    super(`Entry action not found: ${action}`);
  }
}

export interface RegistrationResult {
  entry: ClientEntry;
  created: boolean;
}

export interface EntryServiceOptions {
  refreshConcurrency?: number;
}

export class EntryService {
  private readonly refreshConcurrency: number;

  constructor(
    private readonly registry: Registry,
    private readonly picker: FolderPicker,
    private readonly launcher: ActionLauncher,
    private readonly warn: (message: string) => void = console.warn,
    private readonly sessionManager?: Pick<SessionManager, "startSession">,
    options: EntryServiceOptions = {},
  ) {
    this.refreshConcurrency = options.refreshConcurrency ?? 8;
    if (
      !Number.isSafeInteger(this.refreshConcurrency) ||
      this.refreshConcurrency < 1
    ) {
      throw new Error("Entry refresh concurrency must be positive.");
    }
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
  }

  async listEntries(): Promise<ClientEntry[]> {
    const data = await this.registry.read();
    const pinnedPositions = new Map(
      data.pinnedEntryIds.map((entryId, index) => [entryId, index]),
    );

    const refreshedEntries = await mapConcurrent(
      data.entries,
      this.refreshConcurrency,
      async (entry) => {
        const refreshed = await this.refreshEntry(entry);
        return { original: entry, ...refreshed };
      },
    );
    const changedEntries = refreshedEntries.filter(({ changed }) => changed);
    if (changedEntries.length > 0) {
      await this.registry.update((current) => {
        for (const { original, entry } of changedEntries) {
          mergeLastKnown(current, original, entry.lastKnown);
        }
      });
    }

    const entries = refreshedEntries.map(({ entry, available }) =>
      toClientEntry(
        entry,
        available,
        pinnedPositions.get(entry.id) ?? null,
      ),
    );

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
    return await this.registerLocation(selectedPath);
  }

  async inspectLocation(selectedPath: string): Promise<IntegrationInspection> {
    return await inspectIntegration(parseEntryLocation(selectedPath));
  }

  async registerLocation(selectedPath: string): Promise<RegistrationResult> {
    const location = parseEntryLocation(selectedPath);
    const snapshot = await this.registry.read();
    const duplicate = findByLocation(snapshot, location);
    if (duplicate) {
      const refreshed = await this.refreshEntry(duplicate);
      if (refreshed.changed) {
        await this.mergeRefreshedEntry(duplicate, refreshed.entry);
      }
      const current = await this.registry.read();
      const currentDuplicate = findByLocation(current, location);
      if (currentDuplicate) {
        return {
          entry: toClientEntry(
            currentDuplicate,
            refreshed.available,
            pinPosition(current, currentDuplicate.id),
          ),
          created: false,
        };
      }
    }

    if (!(await isFolderAvailable(location))) {
      throw new SelectedFolderUnavailableError();
    }

    const id = randomUUID();
    const metadata = await readEntryMetadata(location, this.warn);
    const registration = await this.registry.update((data) => {
      const currentDuplicate = findByLocation(data, location);
      if (currentDuplicate) {
        return { id: currentDuplicate.id, created: false };
      }
      data.entries.push({
        id,
        location,
        lastKnown: {
          ...metadata.presentation,
          hasCustomIcon: false,
        },
      });
      return { id, created: true };
    });
    const hasCustomIcon = await this.syncCachedIcon(
      registration.id,
      metadata,
    );
    await this.registry.update((data) => {
      const entry = data.entries.find(
        (candidate) => candidate.id === registration.id,
      );
      if (entry && locationKey(entry.location) === locationKey(location)) {
        entry.lastKnown = {
          ...metadata.presentation,
          hasCustomIcon,
        };
      }
    });
    const current = await this.registry.read();
    const entry = requireEntry(current, registration.id);

    return {
      entry: toClientEntry(
        entry,
        true,
        pinPosition(current, entry.id),
      ),
      created: registration.created,
    };
  }

  async performAction(entryId: string, action: ActionName): Promise<void> {
    const data = await this.registry.read();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }
    if (!(await isFolderAvailable(entry.location))) {
      throw new EntryUnavailableError(entryId);
    }

    if (isBuiltInAction(action)) {
      await this.launcher.launch(action, entry.location);
      return;
    }

    const metadata = await readEntryMetadata(entry.location, this.warn);
    const actionDefinition = metadata.actionDefinitions.find(
      (candidate) => candidate.id === action,
    );
    const sessionDefinition = actionDefinition
      ? metadata.sessionDefinitions.find(
          (candidate) => candidate.id === actionDefinition.starts,
        )
      : undefined;
    if (!actionDefinition || !sessionDefinition || !this.sessionManager) {
      throw new ActionNotFoundError(action);
    }
    await this.sessionManager.startSession(entry, sessionDefinition);
  }

  async resolveBuiltInLaunch(
    entryId: string,
    action: BuiltInActionName,
  ): Promise<LaunchCommand> {
    const data = await this.registry.read();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }
    if (!(await isFolderAvailable(entry.location))) {
      throw new EntryUnavailableError(entryId);
    }
    return actionCommand(action, entry.location);
  }

  async getEntryDetails(entryId: string): Promise<EntryDetails> {
    const data = await this.registry.read();
    const entry = data.entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new EntryNotFoundError(entryId);
    }

    const refreshed = await this.refreshEntry(entry);
    if (refreshed.changed) {
      await this.mergeRefreshedEntry(entry, refreshed.entry);
    }
    const current = await this.registry.read();
    const currentEntry = requireEntry(current, entryId);

    return toEntryDetails(
      currentEntry,
      refreshed.available,
      refreshed.metadataStatus,
      pinPosition(current, currentEntry.id),
    );
  }

  async pinEntry(entryId: string): Promise<void> {
    await this.registry.update((data) => {
      requireEntry(data, entryId);
      if (!data.pinnedEntryIds.includes(entryId)) {
        data.pinnedEntryIds.push(entryId);
      }
    });
  }

  async unpinEntry(entryId: string): Promise<void> {
    await this.registry.update((data) => {
      requireEntry(data, entryId);
      const pinIndex = data.pinnedEntryIds.indexOf(entryId);
      if (pinIndex !== -1) {
        data.pinnedEntryIds.splice(pinIndex, 1);
      }
    });
  }

  async reorderPinnedEntries(entryIds: string[]): Promise<void> {
    await this.registry.update((data) => {
      if (
        entryIds.length !== data.pinnedEntryIds.length ||
        new Set(entryIds).size !== entryIds.length ||
        entryIds.some((entryId) => !data.pinnedEntryIds.includes(entryId))
      ) {
        throw new InvalidPinOrderError();
      }
      if (!isDeepStrictEqual(entryIds, data.pinnedEntryIds)) {
        data.pinnedEntryIds = [...entryIds];
      }
    });
  }

  async removeEntry(entryId: string): Promise<void> {
    await this.registry.update((data) => {
      const entryIndex = data.entries.findIndex(
        (candidate) => candidate.id === entryId,
      );
      if (entryIndex === -1) {
        throw new EntryNotFoundError(entryId);
      }

      data.entries.splice(entryIndex, 1);
      data.pinnedEntryIds = data.pinnedEntryIds.filter(
        (candidate) => candidate !== entryId,
      );
    });
    try {
      await this.registry.removeCachedIcon(entryId);
    } catch (error) {
      this.warn(
        `Entry ${entryId} was removed, but its cached icon could not be removed: ${errorMessage(error)}`,
      );
    }
  }

  async readCachedIcon(entryId: string): Promise<Buffer> {
    const data = await this.registry.read();
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

  private async mergeRefreshedEntry(
    original: StoredEntry,
    refreshed: StoredEntry,
  ): Promise<void> {
    await this.registry.update((data) => {
      mergeLastKnown(data, original, refreshed.lastKnown);
    });
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
    const hasCustomIcon = await this.syncCachedIcon(
      entry.id,
      metadata,
      entry.lastKnown.hasCustomIcon,
    );
    const presentation = { ...metadata.presentation, hasCustomIcon };

    const changed = !isDeepStrictEqual(
      presentation,
      entry.lastKnown,
    );
    return {
      entry: changed
        ? { ...entry, lastKnown: presentation }
        : entry,
      available: true,
      changed,
      metadataStatus: metadata.metadataStatus,
    };
  }

  private async syncCachedIcon(
    entryId: string,
    metadata: MetadataResult,
    removeAbsent: boolean = false,
  ): Promise<boolean> {
    const source = metadata.customIconSource;
    if (!source) {
      if (removeAbsent) {
        await this.registry.removeCachedIcon(entryId);
      }
      return false;
    }

    const record = {
      version: 1 as const,
      source: {
        modifiedTimeMs: source.modifiedTimeMs,
        size: source.size,
      },
      normalizerVersion: ICON_NORMALIZER_VERSION,
      color: ENTRY_ICON_COLOR,
    };
    const cached = await this.registry.readIconCacheRecord(entryId);
    if (
      cached &&
      isDeepStrictEqual(cached.source, record.source) &&
      cached.normalizerVersion === record.normalizerVersion &&
      cached.color === record.color
    ) {
      if (cached.status === "invalid") {
        return false;
      }
      if (await this.registry.hasCachedIcon(entryId)) {
        return true;
      }
    }

    if (source.size > MAX_ICON_BYTES) {
      await this.registry.cacheInvalidIcon(entryId, {
        ...record,
        status: "invalid",
      });
      this.warn(
        `Ignoring ${source.path}: SVG icons must be 256 KiB or smaller.`,
      );
      return false;
    }

    let sourceBytes: Buffer;
    try {
      sourceBytes = await readFile(source.path);
    } catch (error) {
      await this.registry.removeCachedIcon(entryId);
      this.warn(`Could not read ${source.path}: ${errorMessage(error)}`);
      return false;
    }

    let normalized: Buffer;
    try {
      normalized = normalizeEntryIcon(sourceBytes);
    } catch (error) {
      await this.registry.cacheInvalidIcon(entryId, {
        ...record,
        status: "invalid",
      });
      this.warn(`Ignoring ${source.path}: ${errorMessage(error)}`);
      return false;
    }

    await this.registry.cacheIcon(entryId, normalized, {
      ...record,
      status: "valid",
    });
    return true;
  }
}

function parseEntryLocation(selectedPath: string): EntryLocation {
  try {
    return parseSelectedPath(selectedPath);
  } catch (error) {
    throw new InvalidEntryPathError(errorMessage(error));
  }
}

function findByLocation(
  data: RegistryData,
  location: EntryLocation,
): StoredEntry | undefined {
  const key = locationKey(location);
  return data.entries.find((entry) => locationKey(entry.location) === key);
}

function requireEntry(data: RegistryData, entryId: string): StoredEntry {
  const entry = data.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    throw new EntryNotFoundError(entryId);
  }
  return entry;
}

function mergeLastKnown(
  data: RegistryData,
  original: StoredEntry,
  lastKnown: StoredEntry["lastKnown"],
): void {
  const current = data.entries.find(
    (candidate) => candidate.id === original.id,
  );
  if (
    current &&
    locationKey(current.location) === locationKey(original.location) &&
    isDeepStrictEqual(current.lastKnown, original.lastKnown)
  ) {
    current.lastKnown = structuredClone(lastKnown);
  }
}

function pinPosition(data: RegistryData, entryId: string): number | null {
  const position = data.pinnedEntryIds.indexOf(entryId);
  return position === -1 ? null : position;
}

function toClientEntry(
  entry: StoredEntry,
  available: boolean,
  pinnedPosition: number | null,
): ClientEntry {
  return {
    id: entry.id,
    name: entry.lastKnown.name,
    tags: [...entry.lastKnown.tags],
    defaultAction: entry.lastKnown.defaultAction,
    actions: entry.lastKnown.actions.map((action) => ({ ...action })),
    available,
    hasCustomIcon: entry.lastKnown.hasCustomIcon,
    pinnedPosition,
  };
}

function isBuiltInAction(action: string): action is BuiltInActionName {
  return action === "folder" || action === "terminal";
}

function toEntryDetails(
  entry: StoredEntry,
  available: boolean,
  metadataStatus: MetadataStatus,
  pinnedPosition: number | null,
): EntryDetails {
  const tags = new Set(entry.lastKnown.tags);
  const tagIcon = TAG_ICON_PRIORITY.find((tag) => tags.has(tag));

  return {
    ...toClientEntry(entry, available, pinnedPosition),
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
        : { kind: "fallback" },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
