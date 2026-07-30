import path from "node:path";
import type { EntryLocation } from "./types.js";

export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function isCommand(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (part) => typeof part === "string" && part.length > 0,
    )
  );
}

export function isEntryLocation(
  value: unknown,
): value is EntryLocation {
  return (
    isRecord(value) &&
    (
      (
        value.kind === "windows" &&
        typeof value.path === "string" &&
        path.win32.isAbsolute(value.path)
      ) ||
      (
        value.kind === "wsl" &&
        typeof value.distribution === "string" &&
        value.distribution.length > 0 &&
        typeof value.path === "string" &&
        value.path.startsWith("/")
      )
    )
  );
}
