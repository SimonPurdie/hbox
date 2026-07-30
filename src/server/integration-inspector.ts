import { readFile } from "node:fs/promises";
import {
  isFolderAvailable,
  readEntryMetadata,
} from "./metadata.js";
import {
  inferredName,
} from "./paths.js";
import {
  MAX_ICON_BYTES,
  normalizeEntryIcon,
} from "./svg-normalizer.js";
import type {
  EntryLocation,
  IntegrationInspection,
} from "./types.js";

export async function inspectIntegration(
  location: EntryLocation,
): Promise<IntegrationInspection> {
  if (!(await isFolderAvailable(location))) {
    return {
      valid: false,
      location,
      metadataStatus: "folder_unavailable",
      effective: {
        name: inferredName(location),
        tags: [],
        defaultAction: null,
        actions: [],
        sessions: [],
      },
      icon: { status: "absent" },
      issues: ["The project folder is not available."],
    };
  }

  const warnings: string[] = [];
  const metadata = await readEntryMetadata(
    location,
    (message) => warnings.push(message),
  );
  const issues = [
    ...warnings,
    ...metadata.diagnostics.map(({ message }) => message),
  ];

  if (metadata.metadataStatus === "not_found") {
    issues.push("The project does not contain .hbox/entry.json.");
  } else if (
    metadata.metadataStatus !== "loaded" &&
    issues.length === 0
  ) {
    issues.push(
      `.hbox/entry.json has status ${metadata.metadataStatus}.`,
    );
  }

  const icon = await inspectIcon(metadata.customIconSource);
  if (icon.status === "invalid") {
    issues.push(icon.message);
  }

  return {
    valid: issues.length === 0,
    location,
    metadataStatus: metadata.metadataStatus,
    effective: {
      name: metadata.presentation.name,
      tags: [...metadata.presentation.tags],
      defaultAction: metadata.presentation.defaultAction,
      actions: metadata.actionDefinitions.map((definition) => ({
        ...definition,
      })),
      sessions: metadata.sessionDefinitions.map((definition) => ({
        ...definition,
        command: [...definition.command],
        stopCommand: definition.stopCommand
          ? [...definition.stopCommand]
          : null,
      })),
    },
    icon,
    issues: [...new Set(issues)],
  };
}

async function inspectIcon(
  source: Awaited<
    ReturnType<typeof readEntryMetadata>
  >["customIconSource"],
): Promise<IntegrationInspection["icon"]> {
  if (!source) {
    return { status: "absent" };
  }
  if (source.size > MAX_ICON_BYTES) {
    return {
      status: "invalid",
      message: "The custom SVG icon is larger than 256 KiB.",
    };
  }

  try {
    const normalized = normalizeEntryIcon(await readFile(source.path));
    return {
      status: "valid",
      normalizedBytes: normalized.byteLength,
    };
  } catch (error) {
    return {
      status: "invalid",
      message: `The custom SVG icon is invalid: ${errorMessage(error)}`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
