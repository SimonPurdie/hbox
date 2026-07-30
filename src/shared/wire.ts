export const TAG_ICON_PRIORITY = [
  "agent",
  "gamedev",
  "browser-extension",
  "desktop",
  "web",
  "script",
  "data",
] as const;

export type TagIcon = (typeof TAG_ICON_PRIORITY)[number];
export type BuiltInActionName = "folder" | "terminal";
export type ActionName = string;
export type MetadataStatus =
  | "loaded"
  | "not_found"
  | "invalid"
  | "unreadable"
  | "folder_unavailable";

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

export interface EntryActionPresentation {
  id: string;
  label: string;
}

export interface StartSessionActionDefinition
  extends EntryActionPresentation {
  starts: string;
}

export interface ProcessSessionDefinition {
  id: string;
  type: "process";
  label: string;
  command: string[];
  stopCommand: string[] | null;
  readyUrl: string | null;
  openUrl: string | null;
  singleInstance: boolean;
}

export interface ClientEntry {
  id: string;
  name: string;
  tags: string[];
  defaultAction: ActionName | null;
  actions: EntryActionPresentation[];
  available: boolean;
  hasCustomIcon: boolean;
  pinnedPosition: number | null;
  nativeLaunch?: Record<BuiltInActionName, string>;
}

export type IconSource =
  | { kind: "custom" }
  | { kind: "tag"; tag: TagIcon }
  | { kind: "fallback" };

export interface EntryDetails extends ClientEntry {
  environment:
    | { kind: "windows" }
    | { kind: "wsl"; distribution: string };
  location: string;
  metadataStatus: MetadataStatus;
  iconSource: IconSource;
}

export interface IntegrationInspection {
  valid: boolean;
  location: EntryLocation;
  metadataStatus: MetadataStatus;
  effective: {
    name: string;
    tags: string[];
    defaultAction: ActionName | null;
    actions: StartSessionActionDefinition[];
    sessions: ProcessSessionDefinition[];
  };
  icon:
    | { status: "absent" }
    | { status: "valid"; normalizedBytes: number }
    | { status: "invalid"; message: string };
  issues: string[];
}

export type SessionStatus =
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "failed"
  | "disconnected";

export interface ClientSession {
  id: string;
  entryId: string;
  entryName: string;
  definitionId: string;
  name: string;
  status: SessionStatus;
  startedAt: string;
  readyAt: string | null;
  url: string | null;
  message: string | null;
  canOpen: boolean;
  canStop: boolean;
  canRestart: boolean;
  canForget: boolean;
  canRecheck: boolean;
}

export interface EntryPathRequest {
  path: string;
}

export interface PinOrderRequest {
  entryIds: string[];
}

export interface PreferencesDto {
  interfaceColor: string;
}

export interface InstanceStatus {
  instanceId: string;
}
