import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
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

export class EntryService {
  constructor(
    private readonly registry: Registry,
    private readonly picker: FolderPicker,
    private readonly launcher: ActionLauncher,
    private readonly warn: (message: string) => void = console.warn,
    private readonly sessionManager?: Pick<SessionManager, "startSession">,
  ) {}

  async initialize(): Promise<void> {
    await this.registry.load();
  }

  async listEntries(): Promise<ClientEntry[]> {
    const data = await this.registry.load();
    let registryChanged = false;
    const pinnedPositions = new Map(
      data.pinnedEntryIds.map((entryId, index) => [entryId, index]),
    );

    const entries = await Promise.all(
      data.entries.map(async (entry) => {
        const refreshed = await this.refreshEntry(entry);
        if (refreshed.changed) {
          entry.lastKnown = refreshed.entry.lastKnown;
          registryChanged = true;
        }
        return toClientEntry(
          refreshed.entry,
          refreshed.available,
          pinnedPositions.get(entry.id) ?? null,
        );
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
    return await this.registerLocation(selectedPath);
  }

  async inspectLocation(selectedPath: string): Promise<IntegrationInspection> {
    return await inspectIntegration(parseEntryLocation(selectedPath));
  }

  async registerLocation(selectedPath: string): Promise<RegistrationResult> {
    const location = parseEntryLocation(selectedPath);
    const data = await this.registry.load();
    const duplicate = findByLocation(data, location);
    if (duplicate) {
      const refreshed = await this.refreshEntry(duplicate);
      if (refreshed.changed) {
        duplicate.lastKnown = refreshed.entry.lastKnown;
        await this.registry.save(data);
      }
      return {
        entry: toClientEntry(
          refreshed.entry,
          refreshed.available,
          pinPosition(data, duplicate.id),
        ),
        created: false,
      };
    }

    if (!(await isFolderAvailable(location))) {
      throw new SelectedFolderUnavailableError();
    }

    const id = randomUUID();
    const metadata = await readEntryMetadata(location, this.warn);
    const hasCustomIcon = await this.syncCachedIcon(id, metadata);

    const entry: StoredEntry = {
      id,
      location,
      lastKnown: { ...metadata.presentation, hasCustomIcon },
    };
    data.entries.push(entry);
    await this.registry.save(data);

    return {
      entry: toClientEntry(entry, true, null),
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
    const data = await this.registry.load();
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
      pinPosition(data, entry.id),
    );
  }

  async pinEntry(entryId: string): Promise<void> {
    const data = await this.registry.load();
    requireEntry(data, entryId);
    if (!data.pinnedEntryIds.includes(entryId)) {
      data.pinnedEntryIds.push(entryId);
      await this.registry.save(data);
    }
  }

  async unpinEntry(entryId: string): Promise<void> {
    const data = await this.registry.load();
    requireEntry(data, entryId);
    const pinIndex = data.pinnedEntryIds.indexOf(entryId);
    if (pinIndex !== -1) {
      data.pinnedEntryIds.splice(pinIndex, 1);
      await this.registry.save(data);
    }
  }

  async reorderPinnedEntries(entryIds: string[]): Promise<void> {
    const data = await this.registry.load();
    if (
      entryIds.length !== data.pinnedEntryIds.length ||
      new Set(entryIds).size !== entryIds.length ||
      entryIds.some((entryId) => !data.pinnedEntryIds.includes(entryId))
    ) {
      throw new InvalidPinOrderError();
    }
    if (!isDeepStrictEqual(entryIds, data.pinnedEntryIds)) {
      data.pinnedEntryIds = [...entryIds];
      await this.registry.save(data);
    }
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
    data.pinnedEntryIds = data.pinnedEntryIds.filter(
      (candidate) => candidate !== entryId,
    );
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
    const hasCustomIcon = await this.syncCachedIcon(
      entry.id,
      metadata,
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
  ): Promise<boolean> {
    const source = metadata.customIconSource;
    if (!source) {
      await this.registry.removeCachedIcon(entryId);
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
