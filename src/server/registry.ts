import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  REGISTRY_VERSION,
  type EntryLocation,
  type EntryPresentation,
  type RegistryData,
  type StoredEntry,
} from "./types.js";

export interface IconCacheRecord {
  version: 1;
  source: {
    modifiedTimeMs: number;
    size: number;
  };
  normalizerVersion: number;
  color: string;
  status: "valid" | "invalid";
}

export class Registry {
  readonly dataDirectory: string;
  readonly registryPath: string;
  readonly iconDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = dataDirectory;
    this.registryPath = path.join(dataDirectory, "entries.json");
    this.iconDirectory = path.join(dataDirectory, "icons");
  }

  async load(): Promise<RegistryData> {
    let raw: string;
    try {
      raw = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          version: REGISTRY_VERSION,
          entries: [],
          pinnedEntryIds: [],
        };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `HBOX registry is not valid JSON: ${this.registryPath}`,
        { cause: error },
      );
    }

    const normalized = normalizeRegistryData(value);
    if (!normalized) {
      throw new Error(
        `HBOX registry has an unsupported or invalid structure: ${this.registryPath}`,
      );
    }

    return normalized;
  }

  async save(data: RegistryData): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = `${this.registryPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.registryPath);
  }

  iconPath(entryId: string): string {
    return path.join(this.iconDirectory, `${entryId}.svg`);
  }

  iconCacheRecordPath(entryId: string): string {
    return path.join(this.iconDirectory, `${entryId}.json`);
  }

  async readIconCacheRecord(entryId: string): Promise<IconCacheRecord | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.iconCacheRecordPath(entryId), "utf8"),
      );
      return isIconCacheRecord(parsed) ? parsed : null;
    } catch (error) {
      if (
        isMissingFileError(error) ||
        error instanceof SyntaxError
      ) {
        return null;
      }
      throw error;
    }
  }

  async hasCachedIcon(entryId: string): Promise<boolean> {
    try {
      return (await stat(this.iconPath(entryId))).isFile();
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  async cacheIcon(
    entryId: string,
    icon: Buffer,
    record: IconCacheRecord,
  ): Promise<void> {
    await mkdir(this.iconDirectory, { recursive: true });
    const destination = this.iconPath(entryId);
    let iconChanged = true;
    try {
      const current = await readFile(destination);
      if (current.equals(icon)) {
        iconChanged = false;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    if (iconChanged) {
      const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporaryPath, icon);
      await rename(temporaryPath, destination);
    }
    await writeJsonAtomically(this.iconCacheRecordPath(entryId), record);
  }

  async cacheInvalidIcon(
    entryId: string,
    record: IconCacheRecord,
  ): Promise<void> {
    await mkdir(this.iconDirectory, { recursive: true });
    await rm(this.iconPath(entryId), { force: true });
    await writeJsonAtomically(this.iconCacheRecordPath(entryId), record);
  }

  async removeCachedIcon(entryId: string): Promise<void> {
    await Promise.all([
      rm(this.iconPath(entryId), { force: true }),
      rm(this.iconCacheRecordPath(entryId), { force: true }),
    ]);
  }
}

export function defaultDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "LOCALAPPDATA is unavailable. HBOX must be started from Windows.",
    );
  }
  return path.join(localAppData, "HBOX");
}

function normalizeRegistryData(value: unknown): RegistryData | null {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) {
    return null;
  }
  if (
    !Array.isArray(value.entries) ||
    !value.entries.every(isStoredEntry) ||
    (value.pinnedEntryIds !== undefined &&
      (!Array.isArray(value.pinnedEntryIds) ||
        !value.pinnedEntryIds.every((id) => typeof id === "string")))
  ) {
    return null;
  }

  const entries = (value.entries as StoredEntry[]).map((entry) => ({
    ...entry,
    lastKnown: {
      ...entry.lastKnown,
      actions: entry.lastKnown.actions ?? [],
    },
  }));
  const entryIds = new Set(entries.map((entry) => entry.id));
  const pinnedEntryIds = [
    ...new Set(
      (value.pinnedEntryIds as string[] | undefined) ?? [],
    ),
  ].filter((id) => entryIds.has(id));

  return {
    version: REGISTRY_VERSION,
    entries,
    pinnedEntryIds,
  };
}

function isStoredEntry(value: unknown): value is StoredEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isUuid(value.id) &&
    isLocation(value.location) &&
    isPresentation(value.lastKnown)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isLocation(value: unknown): value is EntryLocation {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "windows") {
    return typeof value.path === "string" && value.path.length > 0;
  }
  return (
    value.kind === "wsl" &&
    typeof value.distribution === "string" &&
    value.distribution.length > 0 &&
    typeof value.path === "string" &&
    value.path.startsWith("/")
  );
}

function isPresentation(value: unknown): value is EntryPresentation {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    isNullableAction(value.defaultAction) &&
    (value.actions === undefined ||
      (Array.isArray(value.actions) &&
        value.actions.every(isEntryActionPresentation))) &&
    typeof value.hasCustomIcon === "boolean"
  );
}

function isNullableAction(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isEntryActionPresentation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isIconCacheRecord(value: unknown): value is IconCacheRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.source) &&
    typeof value.source.modifiedTimeMs === "number" &&
    Number.isFinite(value.source.modifiedTimeMs) &&
    typeof value.source.size === "number" &&
    Number.isSafeInteger(value.source.size) &&
    value.source.size >= 0 &&
    typeof value.normalizerVersion === "number" &&
    Number.isSafeInteger(value.normalizerVersion) &&
    typeof value.color === "string" &&
    (value.status === "valid" || value.status === "invalid")
  );
}

async function writeJsonAtomically(
  destination: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, destination);
}
