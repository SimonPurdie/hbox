import {
  TAG_ICON_PRIORITY,
  type ClientEntry,
  type TagIcon,
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
  IconSource,
  InstanceStatus,
  MetadataStatus,
  PinOrderRequest,
  PreferencesDto,
  SessionStatus,
  TagIcon,
} from "../shared/wire.js";

export interface InterfaceTheme {
  foreground: "#ffffff" | "#17202b";
  iconFilter: "none" | "invert(1)";
  shadowColor: string;
  colorScheme: "dark" | "light";
}

export function interfaceThemeFor(color: string): InterfaceTheme {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error("Interface colour is invalid.");
  }
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  const luminance =
    0.2126 * linearChannel(channels[0]!) +
    0.7152 * linearChannel(channels[1]!) +
    0.0722 * linearChannel(channels[2]!);
  const darkLuminance = relativeLuminance("#17202b");
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast =
    (Math.max(luminance, darkLuminance) + 0.05) /
    (Math.min(luminance, darkLuminance) + 0.05);

  return whiteContrast >= darkContrast
    ? {
        foreground: "#ffffff",
        iconFilter: "none",
        shadowColor: "rgb(7 20 32 / 65%)",
        colorScheme: "dark",
      }
    : {
        foreground: "#17202b",
        iconFilter: "invert(1)",
        shadowColor: "rgb(255 255 255 / 60%)",
        colorScheme: "light",
      };
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  return (
    0.2126 * linearChannel(channels[0]!) +
    0.7152 * linearChannel(channels[1]!) +
    0.0722 * linearChannel(channels[2]!)
  );
}

function linearChannel(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
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
