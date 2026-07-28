export const REGISTRY_VERSION = 1 as const;

export const TAG_ICON_PRIORITY = [
  "agent",
  "app",
  "code",
  "script",
  "tool",
  "web",
] as const;

export type TagIcon = (typeof TAG_ICON_PRIORITY)[number];
export type ActionName = "folder" | "terminal";

export interface WindowsLocation {
  kind: "windows";
  path: string;
}

export interface WslLocation {
  kind: "wsl";
  distribution: string;
  path: string;
}

export type EntryLocation = WindowsLocation | WslLocation;

export interface EntryPresentation {
  name: string;
  tags: string[];
  defaultAction: ActionName | null;
  hasCustomIcon: boolean;
}

export interface StoredEntry {
  id: string;
  location: EntryLocation;
  lastKnown: EntryPresentation;
}

export interface RegistryData {
  version: typeof REGISTRY_VERSION;
  entries: StoredEntry[];
}

export interface ClientEntry {
  id: string;
  name: string;
  tags: string[];
  defaultAction: ActionName | null;
  available: boolean;
  hasCustomIcon: boolean;
}
