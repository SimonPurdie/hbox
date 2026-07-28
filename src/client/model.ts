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
export type ActionName = "folder" | "terminal";
export type MetadataStatus =
  | "loaded"
  | "not_found"
  | "invalid"
  | "unreadable"
  | "folder_unavailable";

export interface ClientEntry {
  id: string;
  name: string;
  tags: string[];
  defaultAction: ActionName | null;
  available: boolean;
  hasCustomIcon: boolean;
  pinnedPosition: number | null;
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

export function tagIconFor(entry: ClientEntry): TagIcon | null {
  if (entry.hasCustomIcon) {
    return null;
  }
  const tags = new Set(
    entry.tags.map((tag) => tag.toLocaleLowerCase("en-US")),
  );
  return TAG_ICON_PRIORITY.find((tag) => tags.has(tag)) ?? null;
}

export function matchesEntry(entry: ClientEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return true;
  }
  return (
    entry.name.toLocaleLowerCase("en-US").includes(normalized) ||
    entry.tags.some((tag) =>
      tag.toLocaleLowerCase("en-US").includes(normalized),
    )
  );
}

export function mergeVisiblePinOrder(
  currentOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visible = new Set(visibleOrder);
  if (
    visible.size !== visibleOrder.length ||
    visibleOrder.some((id) => !currentOrder.includes(id))
  ) {
    throw new Error("Visible pin order does not match the pinned Entries.");
  }

  let visibleIndex = 0;
  return currentOrder.map((id) =>
    visible.has(id) ? visibleOrder[visibleIndex++]! : id,
  );
}
