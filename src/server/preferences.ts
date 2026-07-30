import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { PreferencesDto } from "./types.js";

export const DEFAULT_INTERFACE_COLOR = "#193b56";

export type Preferences = PreferencesDto;

export class InvalidPreferencesError extends Error {}

export class PreferencesStore {
  readonly preferencesPath: string;

  constructor(private readonly dataDirectory: string) {
    this.preferencesPath = path.join(dataDirectory, "preferences.json");
  }

  async load(): Promise<Preferences> {
    let raw: string;
    try {
      raw = await readFile(this.preferencesPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return { interfaceColor: DEFAULT_INTERFACE_COLOR };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `HBOX preferences are not valid JSON: ${this.preferencesPath}`,
        { cause: error },
      );
    }

    return normalizePreferences(value);
  }

  async save(value: unknown): Promise<Preferences> {
    const preferences = normalizePreferences(value);
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = `${this.preferencesPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(preferences, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.preferencesPath);
    return preferences;
  }
}

function normalizePreferences(value: unknown): Preferences {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("interfaceColor" in value) ||
    typeof value.interfaceColor !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(value.interfaceColor)
  ) {
    throw new InvalidPreferencesError(
      "Interface colour must be a six-digit hexadecimal colour.",
    );
  }
  return { interfaceColor: value.interfaceColor.toLowerCase() };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
