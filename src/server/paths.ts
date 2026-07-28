import path from "node:path";
import type { EntryLocation } from "./types.js";

const WSL_UNC_PATTERN =
  /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i;

export function parseSelectedPath(selectedPath: string): EntryLocation {
  const value = selectedPath.trim();
  if (!value) {
    throw new Error("The selected path is empty.");
  }

  const wslMatch = WSL_UNC_PATTERN.exec(value);
  if (wslMatch) {
    const distribution = wslMatch[1];
    if (!distribution) {
      throw new Error("The WSL path does not include a distribution.");
    }

    const remainder = wslMatch[2] ?? "";
    const linuxPath = path.posix.normalize(
      `/${remainder.split("\\").filter(Boolean).join("/")}`,
    );

    return {
      kind: "wsl",
      distribution,
      path: linuxPath,
    };
  }

  // Keep core services testable from WSL/Linux while production selections
  // continue to use native Windows paths.
  if (process.platform !== "win32" && path.posix.isAbsolute(value)) {
    return {
      kind: "windows",
      path: path.posix.normalize(value),
    };
  }

  const normalized = path.win32.normalize(value);
  if (!path.win32.isAbsolute(normalized)) {
    throw new Error("The selected folder must have an absolute path.");
  }

  return {
    kind: "windows",
    path: trimWindowsTrailingSeparator(normalized),
  };
}

export function locationAccessPath(location: EntryLocation): string {
  if (location.kind === "windows") {
    return location.path;
  }

  const remainder = location.path
    .split("/")
    .filter(Boolean)
    .join("\\");

  return `\\\\wsl.localhost\\${location.distribution}${
    remainder ? `\\${remainder}` : ""
  }`;
}

export function locationKey(location: EntryLocation): string {
  if (location.kind === "windows") {
    return `windows:${trimWindowsTrailingSeparator(
      path.win32.normalize(location.path),
    ).toLocaleLowerCase("en-US")}`;
  }

  return `wsl:${location.distribution.toLocaleLowerCase("en-US")}:${path.posix.normalize(location.path)}`;
}

export function inferredName(location: EntryLocation): string {
  if (location.kind === "windows") {
    const base = path.win32.basename(location.path);
    return base || location.path;
  }

  const base = path.posix.basename(location.path);
  return base || location.distribution;
}

function trimWindowsTrailingSeparator(value: string): string {
  const root = path.win32.parse(value).root;
  if (value === root) {
    return value;
  }
  return value.replace(/[\\/]+$/, "");
}
