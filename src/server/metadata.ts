import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { inferredName, locationAccessPath } from "./paths.js";
import type {
  ActionName,
  EntryLocation,
  EntryPresentation,
  MetadataStatus,
} from "./types.js";

const runtimePath = process.platform === "win32" ? path.win32 : path;

export interface CustomIconSource {
  path: string;
  modifiedTimeMs: number;
  size: number;
}

export interface MetadataResult {
  presentation: EntryPresentation;
  customIconSource: CustomIconSource | null;
  metadataStatus: MetadataStatus;
}

export async function isFolderAvailable(
  location: EntryLocation,
): Promise<boolean> {
  try {
    return (await stat(locationAccessPath(location))).isDirectory();
  } catch {
    return false;
  }
}

export async function readEntryMetadata(
  location: EntryLocation,
  warn: (message: string) => void = console.warn,
): Promise<MetadataResult> {
  const folderPath = locationAccessPath(location);
  const metadataPath = runtimePath.join(folderPath, ".hbox", "entry.json");
  const iconPath = runtimePath.join(folderPath, ".hbox", "icon.svg");
  const fallback: EntryPresentation = {
    name: inferredName(location),
    tags: [],
    defaultAction: null,
    hasCustomIcon: false,
  };

  let presentation = fallback;
  let metadataStatus: MetadataStatus = "not_found";
  try {
    const raw = await readFile(metadataPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        presentation = parseMetadataValue(parsed, fallback);
        metadataStatus = "loaded";
      } else {
        metadataStatus = "invalid";
        warn(`Could not parse ${metadataPath}: expected a JSON object.`);
      }
    } catch {
      metadataStatus = "invalid";
      warn(`Could not parse ${metadataPath}: invalid JSON.`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      metadataStatus = "unreadable";
      warn(`Could not read ${metadataPath}: ${errorMessage(error)}`);
    }
  }

  try {
    const iconInfo = await stat(iconPath);
    if (!iconInfo.isFile()) {
      return { presentation, customIconSource: null, metadataStatus };
    }

    return {
      presentation,
      customIconSource: {
        path: iconPath,
        modifiedTimeMs: iconInfo.mtimeMs,
        size: iconInfo.size,
      },
      metadataStatus,
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      warn(`Could not read ${iconPath}: ${errorMessage(error)}`);
    }
    return { presentation, customIconSource: null, metadataStatus };
  }
}

export function parseMetadata(
  raw: string,
  fallback: EntryPresentation,
): EntryPresentation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fallback;
  }

  return parseMetadataValue(value, fallback);
}

function parseMetadataValue(
  value: unknown,
  fallback: EntryPresentation,
): EntryPresentation {
  if (!isRecord(value)) {
    return fallback;
  }
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : fallback.name;

  const tags = Array.isArray(value.tags)
    ? [
        ...new Set(
          value.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim().toLocaleLowerCase("en-US"))
            .filter(Boolean),
        ),
      ]
    : [];

  const defaultAction = isActionName(value.defaultAction)
    ? value.defaultAction
    : null;

  return {
    name,
    tags,
    defaultAction,
    hasCustomIcon: false,
  };
}

function isActionName(value: unknown): value is ActionName {
  return value === "folder" || value === "terminal";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
