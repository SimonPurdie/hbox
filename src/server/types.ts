import type {
  ActionName,
  EntryActionPresentation,
  EntryLocation,
} from "../shared/wire.js";

export {
  TAG_ICON_PRIORITY,
} from "../shared/wire.js";
export type {
  ActionName,
  BuiltInActionName,
  ClientEntry,
  ClientSession,
  EntryActionPresentation,
  EntryDetails,
  EntryLocation,
  IconSource,
  InstanceStatus,
  IntegrationInspection,
  MetadataStatus,
  EntryPathRequest,
  PinOrderRequest,
  PreferencesDto,
  ProcessSessionDefinition,
  SessionStatus,
  StartSessionActionDefinition,
  TagIcon,
  WindowsLocation,
  WslLocation,
} from "../shared/wire.js";

export const REGISTRY_VERSION = 1 as const;

export interface EntryPresentation {
  name: string;
  tags: string[];
  defaultAction: ActionName | null;
  actions: EntryActionPresentation[];
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
  pinnedEntryIds: string[];
}
