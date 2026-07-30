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
import {
  isCommand,
  isRecord,
} from "./validation.js";

const runtimePath = process.platform === "win32" ? path.win32 : path;

export interface CustomIconSource {
  path: string;
  modifiedTimeMs: number;
  size: number;
}

export interface MetadataDiagnostic {
  path: string;
  code: string;
  message: string;
}

export interface MetadataResult {
  presentation: EntryPresentation;
  actionDefinitions: StartSessionActionDefinition[];
  sessionDefinitions: ProcessSessionDefinition[];
  customIconSource: CustomIconSource | null;
  metadataStatus: MetadataStatus;
  diagnostics: MetadataDiagnostic[];
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
  const customIconSource = readCustomIconSource(iconPath, warn);
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
  let diagnostics: MetadataDiagnostic[] = [];
  try {
    const raw = await readFile(metadataPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      const metadata = parseMetadataValue(parsed, fallback);
      presentation = metadata.presentation;
      actionDefinitions = metadata.actionDefinitions;
      sessionDefinitions = metadata.sessionDefinitions;
      diagnostics = metadata.diagnostics;
      metadataStatus = isRecord(parsed) ? "loaded" : "invalid";
    } catch {
      metadataStatus = "invalid";
      diagnostics = [
        createDiagnostic(
          "$",
          "invalid_json",
          "must contain valid JSON.",
        ),
      ];
      warn(`Could not parse ${metadataPath}: invalid JSON.`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      metadataStatus = "unreadable";
      warn(`Could not read ${metadataPath}: ${errorMessage(error)}`);
    }
  }

  return {
    presentation,
    actionDefinitions,
    sessionDefinitions,
    customIconSource: await customIconSource,
    metadataStatus,
    diagnostics,
  };
}

async function readCustomIconSource(
  iconPath: string,
  warn: (message: string) => void,
): Promise<CustomIconSource | null> {
  try {
    const iconInfo = await stat(iconPath);
    return iconInfo.isFile()
      ? {
          path: iconPath,
          modifiedTimeMs: iconInfo.mtimeMs,
          size: iconInfo.size,
        }
      : null;
  } catch (error) {
    if (!isMissingFileError(error)) {
      warn(`Could not read ${iconPath}: ${errorMessage(error)}`);
    }
    return null;
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
  diagnostics: MetadataDiagnostic[];
} {
  if (!isRecord(value)) {
    return {
      presentation: fallback,
      actionDefinitions: [],
      sessionDefinitions: [],
      diagnostics: [
        createDiagnostic(
          "$",
          "invalid_root",
          "must be a JSON object.",
        ),
      ],
    };
  }
  const diagnostics: MetadataDiagnostic[] = [];
  let name = fallback.name;
  if (value.name !== undefined) {
    if (typeof value.name === "string" && value.name.trim()) {
      name = value.name.trim();
    } else {
      diagnostics.push(
        createDiagnostic(
          "name",
          "invalid_name",
          "must be a non-empty string.",
        ),
      );
    }
  }

  let tags: string[] = [];
  if (value.tags !== undefined) {
    if (Array.isArray(value.tags)) {
      tags = [
        ...new Set(
          value.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim().toLocaleLowerCase("en-US"))
            .filter(Boolean),
        ),
      ];
    } else {
      diagnostics.push(
        createDiagnostic(
          "tags",
          "invalid_tags",
          "must be an array.",
        ),
      );
    }
  }

  const sessionDefinitions = parseSessionDefinitions(
    value.sessions,
    diagnostics,
  );
  const sessionIds = new Set(
    sessionDefinitions.map((definition) => definition.id),
  );
  const actionDefinitions = parseActionDefinitions(
    value.actions,
    sessionIds,
    diagnostics,
  );
  const actionIds = new Set(
    actionDefinitions.map((definition) => definition.id),
  );
  const defaultAction = isActionName(value.defaultAction, actionIds)
    ? value.defaultAction
    : null;
  if (value.defaultAction !== undefined && defaultAction === null) {
    diagnostics.push(
      createDiagnostic(
        "defaultAction",
        "invalid_default_action",
        'must be "folder", "terminal", or an accepted custom action ID.',
      ),
    );
  }

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
    diagnostics,
  };
}

function parseSessionDefinitions(
  value: unknown,
  diagnostics: MetadataDiagnostic[],
): ProcessSessionDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    diagnostics.push(
      createDiagnostic(
        "sessions",
        "invalid_sessions",
        "must be an object.",
      ),
    );
    return [];
  }

  const definitions: ProcessSessionDefinition[] = [];
  for (const [id, candidate] of Object.entries(value)) {
    const definitionPath = `sessions.${id}`;
    if (!isDefinitionId(id)) {
      diagnostics.push(
        createDiagnostic(
          definitionPath,
          "invalid_definition_id",
          "has an invalid Session ID.",
        ),
      );
      continue;
    }
    if (!isRecord(candidate)) {
      diagnostics.push(
        createDiagnostic(
          definitionPath,
          "invalid_session",
          "must be an object.",
        ),
      );
      continue;
    }

    let valid = true;
    if (candidate.type !== "process") {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.type`,
          "invalid_session_type",
          'must be "process".',
        ),
      );
      valid = false;
    }
    if (
      typeof candidate.label !== "string" ||
      !candidate.label.trim()
    ) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.label`,
          "invalid_label",
          "must be a non-empty string.",
        ),
      );
      valid = false;
    }
    if (!isCommand(candidate.command)) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.command`,
          "invalid_command",
          "must be a non-empty array of non-empty strings.",
        ),
      );
      valid = false;
    }

    const readyUrl = parseOptionalUrl(candidate.readyUrl);
    const openUrl = parseOptionalUrl(candidate.openUrl);
    const stopCommand = parseOptionalCommand(candidate.stopCommand);
    if (stopCommand === undefined) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.stopCommand`,
          "invalid_stop_command",
          "must be a non-empty array of non-empty strings when present.",
        ),
      );
      valid = false;
    }
    if (readyUrl === undefined) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.readyUrl`,
          "invalid_ready_url",
          "must be an HTTP or HTTPS URL when present.",
        ),
      );
      valid = false;
    }
    if (openUrl === undefined) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.openUrl`,
          "invalid_open_url",
          "must be an HTTP or HTTPS URL when present.",
        ),
      );
      valid = false;
    }
    if (!valid) {
      continue;
    }

    definitions.push({
      id,
      type: "process",
      label: (candidate.label as string).trim(),
      command: [...(candidate.command as string[])],
      stopCommand: stopCommand as string[] | null,
      readyUrl: readyUrl as string | null,
      openUrl: openUrl as string | null,
      singleInstance: candidate.singleInstance !== false,
    });
  }
  return definitions;
}

function parseActionDefinitions(
  value: unknown,
  sessionIds: ReadonlySet<string>,
  diagnostics: MetadataDiagnostic[],
): StartSessionActionDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    diagnostics.push(
      createDiagnostic(
        "actions",
        "invalid_actions",
        "must be an object.",
      ),
    );
    return [];
  }

  const definitions: StartSessionActionDefinition[] = [];
  for (const [id, candidate] of Object.entries(value)) {
    const definitionPath = `actions.${id}`;
    if (!isDefinitionId(id)) {
      diagnostics.push(
        createDiagnostic(
          definitionPath,
          "invalid_definition_id",
          "has an invalid action ID.",
        ),
      );
      continue;
    }
    if (id === "folder" || id === "terminal") {
      diagnostics.push(
        createDiagnostic(
          definitionPath,
          "reserved_action_id",
          "uses a reserved action ID.",
        ),
      );
      continue;
    }
    if (!isRecord(candidate)) {
      diagnostics.push(
        createDiagnostic(
          definitionPath,
          "invalid_action",
          "must be an object.",
        ),
      );
      continue;
    }

    let valid = true;
    if (
      typeof candidate.label !== "string" ||
      !candidate.label.trim()
    ) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.label`,
          "invalid_label",
          "must be a non-empty string.",
        ),
      );
      valid = false;
    }
    if (
      typeof candidate.starts !== "string" ||
      !sessionIds.has(candidate.starts)
    ) {
      diagnostics.push(
        createDiagnostic(
          `${definitionPath}.starts`,
          "unknown_session",
          "must reference an accepted Session ID.",
        ),
      );
      valid = false;
    }
    if (!valid) {
      continue;
    }
    definitions.push({
      id,
      label: (candidate.label as string).trim(),
      starts: candidate.starts as string,
    });
  }
  return definitions;
}

function createDiagnostic(
  path: string,
  code: string,
  requirement: string,
): MetadataDiagnostic {
  return {
    path,
    code,
    message: `${path} ${requirement}`,
  };
}

function isDefinitionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function parseOptionalCommand(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return null;
  }
  return isCommand(value) ? [...value] : undefined;
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
