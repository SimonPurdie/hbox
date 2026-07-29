import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { inferredName, locationAccessPath } from "./paths.js";
import type {
  ActionName,
  EntryLocation,
  EntryPresentation,
  MetadataStatus,
  ProcessSessionDefinition,
  StartSessionActionDefinition,
} from "./types.js";

const runtimePath = process.platform === "win32" ? path.win32 : path;

export interface CustomIconSource {
  path: string;
  modifiedTimeMs: number;
  size: number;
}

export interface MetadataResult {
  presentation: EntryPresentation;
  actionDefinitions: StartSessionActionDefinition[];
  sessionDefinitions: ProcessSessionDefinition[];
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
    actions: [],
    hasCustomIcon: false,
  };

  let presentation = fallback;
  let actionDefinitions: StartSessionActionDefinition[] = [];
  let sessionDefinitions: ProcessSessionDefinition[] = [];
  let metadataStatus: MetadataStatus = "not_found";
  try {
    const raw = await readFile(metadataPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        const metadata = parseMetadataValue(parsed, fallback);
        presentation = metadata.presentation;
        actionDefinitions = metadata.actionDefinitions;
        sessionDefinitions = metadata.sessionDefinitions;
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
      return {
        presentation,
        actionDefinitions,
        sessionDefinitions,
        customIconSource: null,
        metadataStatus,
      };
    }

    return {
      presentation,
      actionDefinitions,
      sessionDefinitions,
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
    return {
      presentation,
      actionDefinitions,
      sessionDefinitions,
      customIconSource: null,
      metadataStatus,
    };
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

  return parseMetadataValue(value, fallback).presentation;
}

function parseMetadataValue(
  value: unknown,
  fallback: EntryPresentation,
): {
  presentation: EntryPresentation;
  actionDefinitions: StartSessionActionDefinition[];
  sessionDefinitions: ProcessSessionDefinition[];
} {
  if (!isRecord(value)) {
    return {
      presentation: fallback,
      actionDefinitions: [],
      sessionDefinitions: [],
    };
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

  const sessionDefinitions = parseSessionDefinitions(value.sessions);
  const sessionIds = new Set(
    sessionDefinitions.map((definition) => definition.id),
  );
  const actionDefinitions = parseActionDefinitions(
    value.actions,
    sessionIds,
  );
  const actionIds = new Set(
    actionDefinitions.map((definition) => definition.id),
  );
  const defaultAction = isActionName(value.defaultAction, actionIds)
    ? value.defaultAction
    : null;

  return {
    presentation: {
      name,
      tags,
      defaultAction,
      actions: actionDefinitions.map(({ id, label }) => ({ id, label })),
      hasCustomIcon: false,
    },
    actionDefinitions,
    sessionDefinitions,
  };
}

function parseSessionDefinitions(
  value: unknown,
): ProcessSessionDefinition[] {
  if (!isRecord(value)) {
    return [];
  }

  const definitions: ProcessSessionDefinition[] = [];
  for (const [id, candidate] of Object.entries(value)) {
    if (
      !isDefinitionId(id) ||
      !isRecord(candidate) ||
      candidate.type !== "process" ||
      typeof candidate.label !== "string" ||
      !candidate.label.trim() ||
      !isCommand(candidate.command)
    ) {
      continue;
    }

    const readyUrl = parseOptionalUrl(candidate.readyUrl);
    const openUrl = parseOptionalUrl(candidate.openUrl);
    if (readyUrl === undefined || openUrl === undefined) {
      continue;
    }

    definitions.push({
      id,
      type: "process",
      label: candidate.label.trim(),
      command: [...candidate.command],
      readyUrl,
      openUrl,
      singleInstance: candidate.singleInstance !== false,
    });
  }
  return definitions;
}

function parseActionDefinitions(
  value: unknown,
  sessionIds: ReadonlySet<string>,
): StartSessionActionDefinition[] {
  if (!isRecord(value)) {
    return [];
  }

  const definitions: StartSessionActionDefinition[] = [];
  for (const [id, candidate] of Object.entries(value)) {
    if (
      !isDefinitionId(id) ||
      id === "folder" ||
      id === "terminal" ||
      !isRecord(candidate) ||
      typeof candidate.label !== "string" ||
      !candidate.label.trim() ||
      typeof candidate.starts !== "string" ||
      !sessionIds.has(candidate.starts)
    ) {
      continue;
    }
    definitions.push({
      id,
      label: candidate.label.trim(),
      starts: candidate.starts,
    });
  }
  return definitions;
}

function isDefinitionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function isCommand(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (part) => typeof part === "string" && part.length > 0,
    )
  );
}

function parseOptionalUrl(value: unknown): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isActionName(
  value: unknown,
  customActionIds: ReadonlySet<string>,
): value is ActionName {
  return (
    typeof value === "string" &&
    (value === "folder" ||
      value === "terminal" ||
      customActionIds.has(value))
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
