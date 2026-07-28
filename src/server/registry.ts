import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  REGISTRY_VERSION,
  type ActionName,
  type EntryLocation,
  type EntryPresentation,
  type RegistryData,
  type StoredEntry,
} from "./types.js";

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
        return { version: REGISTRY_VERSION, entries: [] };
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

    if (!isRegistryData(value)) {
      throw new Error(
        `HBOX registry has an unsupported or invalid structure: ${this.registryPath}`,
      );
    }

    return value;
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

  async cacheIcon(entryId: string, icon: Buffer): Promise<void> {
    await mkdir(this.iconDirectory, { recursive: true });
    const destination = this.iconPath(entryId);
    try {
      const current = await readFile(destination);
      if (current.equals(icon)) {
        return;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, icon);
    await rename(temporaryPath, destination);
  }

  async removeCachedIcon(entryId: string): Promise<void> {
    await rm(this.iconPath(entryId), { force: true });
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

function isRegistryData(value: unknown): value is RegistryData {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) {
    return false;
  }
  return Array.isArray(value.entries) && value.entries.every(isStoredEntry);
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
    typeof value.hasCustomIcon === "boolean"
  );
}

function isNullableAction(value: unknown): value is ActionName | null {
  return value === null || value === "folder" || value === "terminal";
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
