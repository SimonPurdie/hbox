import {
  interfaceThemeFor,
  mergeVisiblePinOrder,
  matchesEntry,
  tagIconFor,
  type ActionName,
  type BuiltInActionName,
  type ClientEntry,
  type ClientSession,
  type EntryDetails,
  type MetadataStatus,
  type TagIcon,
} from "./model.js";

const tagIconUrls: Record<TagIcon, string> = {
  agent: "/assets/icons/tag-agent.svg",
  gamedev: "/assets/icons/tag-gamedev.svg",
  "browser-extension": "/assets/icons/tag-browser-extension.svg",
  desktop: "/assets/icons/tag-desktop.svg",
  web: "/assets/icons/tag-web.svg",
  script: "/assets/icons/tag-script.svg",
  data: "/assets/icons/tag-data.svg",
};

const desktop = requiredElement<HTMLElement>("desktop");
const pinnedSection = requiredElement<HTMLElement>("pinned-section");
const pinnedEntries = requiredElement<HTMLElement>("pinned-entries");
const allSection = requiredElement<HTMLElement>("all-section");
const allEntries = requiredElement<HTMLElement>("all-entries");
const addButton = requiredElement<HTMLButtonElement>("add-entry");
const sessionsButton =
  requiredElement<HTMLButtonElement>("open-sessions");
const sessionCount = requiredElement<HTMLElement>("session-count");
const sessionsPane = requiredElement<HTMLElement>("sessions-pane");
const closeSessionsButton =
  requiredElement<HTMLButtonElement>("close-sessions");
const sessionList = requiredElement<HTMLElement>("session-list");
const configButton = requiredElement<HTMLButtonElement>("open-config");
const contextMenu = requiredElement<HTMLElement>("context-menu");
const customActions = requiredElement<HTMLElement>("custom-actions");
const pinEntryButton = requiredElement<HTMLButtonElement>("pin-entry");
const manageEntryButton =
  requiredElement<HTMLButtonElement>("manage-entry");
const configMenu = requiredElement<HTMLElement>("config-menu");
const restartButton =
  requiredElement<HTMLButtonElement>("restart-server");
const interfaceColorInput =
  requiredElement<HTMLInputElement>("interface-color");
const searchShell = requiredElement<HTMLElement>("search-shell");
const searchInput = requiredElement<HTMLInputElement>("search");
const detailsDialog =
  requiredElement<HTMLDialogElement>("entry-details-dialog");
const detailsTitle = requiredElement<HTMLElement>("entry-details-title");
const closeDetailsButton =
  requiredElement<HTMLButtonElement>("close-entry-details");
const removeEntryButton =
  requiredElement<HTMLButtonElement>("remove-entry");
const detailLocation = requiredElement<HTMLElement>("entry-detail-location");
const detailEnvironment =
  requiredElement<HTMLElement>("entry-detail-environment");
const detailAvailability =
  requiredElement<HTMLElement>("entry-detail-availability");
const detailTags = requiredElement<HTMLElement>("entry-detail-tags");
const detailDefault = requiredElement<HTMLElement>("entry-detail-default");
const detailMetadata = requiredElement<HTMLElement>("entry-detail-metadata");
const detailIcon = requiredElement<HTMLElement>("entry-detail-icon");
const detailId = requiredElement<HTMLElement>("entry-detail-id");

Coloris({
  el: "#interface-color",
  alpha: false,
  swatches: [],
});

let entries: ClientEntry[] = [];
let sessions: ClientSession[] = [];
let sessionsLoading = false;
let contextEntry: ClientEntry | null = null;
let managedEntry: EntryDetails | null = null;
let detailsOrigin: HTMLElement | null = null;
let draggedPinnedElement: HTMLButtonElement | null = null;

addButton.addEventListener("click", () => void addEntry());
sessionsButton.addEventListener("click", () => {
  setSessionsPaneOpen(sessionsPane.hidden);
});
closeSessionsButton.addEventListener("click", () => {
  setSessionsPaneOpen(false);
  sessionsButton.focus();
});
configButton.addEventListener("click", toggleConfigMenu);
restartButton.addEventListener("click", () => void restartServer());
interfaceColorInput.addEventListener("input", () => {
  if (/^#[0-9a-f]{6}$/i.test(interfaceColorInput.value)) {
    applyInterfaceColor(interfaceColorInput.value);
  }
});
interfaceColorInput.addEventListener("change", () => {
  if (/^#[0-9a-f]{6}$/i.test(interfaceColorInput.value)) {
    void saveInterfaceColor(interfaceColorInput.value);
  } else {
    void loadPreferences();
  }
});
pinEntryButton.addEventListener("click", () => {
  const entry = contextEntry;
  if (!entry) {
    return;
  }
  closeContextMenu();
  void setEntryPinned(entry, entry.pinnedPosition === null);
});
manageEntryButton.addEventListener("click", () => {
  if (contextEntry) {
    void openEntryDetails(contextEntry);
  }
});
closeDetailsButton.addEventListener("click", () => detailsDialog.close());
removeEntryButton.addEventListener("click", () => void removeManagedEntry());
detailsDialog.addEventListener("click", (event) => {
  if (event.target === detailsDialog) {
    detailsDialog.close();
  }
});
detailsDialog.addEventListener("close", () => {
  managedEntry = null;
  removeEntryButton.disabled = false;
  if (detailsOrigin?.isConnected) {
    detailsOrigin.focus();
  }
  detailsOrigin = null;
});
searchInput.addEventListener("input", () => {
  if (!searchInput.value) {
    hideSearch();
  }
  renderEntries();
});

contextMenu.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action]",
  );
  if (!target || target.disabled || !contextEntry) {
    return;
  }
  const action = target.dataset.action as ActionName;
  void runAction(contextEntry, action);
});

pinnedEntries.addEventListener("dragover", (event) => {
  if (!draggedPinnedElement) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    ".entry",
  );
  if (!target || target === draggedPinnedElement) {
    if (!target) {
      pinnedEntries.append(draggedPinnedElement);
    }
    return;
  }

  const bounds = target.getBoundingClientRect();
  pinnedEntries.insertBefore(
    draggedPinnedElement,
    event.clientX < bounds.left + bounds.width / 2
      ? target
      : target.nextSibling,
  );
});

pinnedEntries.addEventListener("drop", (event) => {
  if (!draggedPinnedElement) {
    return;
  }
  event.preventDefault();
  const dragged = draggedPinnedElement;
  draggedPinnedElement = null;
  dragged.classList.remove("dragging");
  void persistVisiblePinOrder();
});

pinnedEntries.addEventListener("dragend", () => {
  if (!draggedPinnedElement) {
    return;
  }
  draggedPinnedElement.classList.remove("dragging");
  draggedPinnedElement = null;
  renderEntries();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (!contextMenu.hidden && !contextMenu.contains(target)) {
    closeContextMenu();
  }
  if (
    !configMenu.hidden &&
    !configMenu.contains(target) &&
    !configButton.contains(target)
  ) {
    closeConfigMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (detailsDialog.open) {
      return;
    }
    if (!contextMenu.hidden) {
      closeContextMenu();
      return;
    }
    if (!configMenu.hidden) {
      closeConfigMenu();
      return;
    }
    if (!sessionsPane.hidden) {
      setSessionsPaneOpen(false);
      sessionsButton.focus();
      return;
    }
    if (!searchShell.hidden) {
      event.preventDefault();
      hideSearch();
      renderEntries();
    }
    return;
  }

  if (
    !contextMenu.hidden ||
    !configMenu.hidden ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.key.length !== 1 ||
    event.target instanceof HTMLInputElement ||
    (event.key === " " &&
      (event.target as HTMLElement | null)?.closest("button"))
  ) {
    return;
  }

  event.preventDefault();
  searchShell.hidden = false;
  searchInput.value += event.key;
  searchInput.focus();
  renderEntries();
});

window.addEventListener("resize", () => {
  closeContextMenu();
  closeConfigMenu();
});
void loadEntries();
void loadSessions();
void loadPreferences();
window.setInterval(() => void loadSessions(), 2_000);

async function loadPreferences(): Promise<void> {
  try {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `Preference request failed with status ${response.status}.`,
      );
    }
    const preferences = (await response.json()) as {
      interfaceColor: string;
    };
    interfaceColorInput.value = preferences.interfaceColor;
    interfaceColorInput.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
  } catch (error) {
    console.error(error);
  }
}

async function saveInterfaceColor(color: string): Promise<void> {
  try {
    const response = await fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interfaceColor: color }),
    });
    if (!response.ok) {
      throw new Error(
        `Preference update failed with status ${response.status}.`,
      );
    }
  } catch (error) {
    console.error(error);
    await loadPreferences();
  }
}

function applyInterfaceColor(color: string): void {
  const theme = interfaceThemeFor(color);
  const root = document.documentElement.style;
  root.setProperty("--interface-color", color);
  root.setProperty("--interface-foreground", theme.foreground);
  root.setProperty("--interface-icon-filter", theme.iconFilter);
  root.setProperty("--interface-shadow-color", theme.shadowColor);
  root.setProperty("color-scheme", theme.colorScheme);
}

async function loadEntries(): Promise<void> {
  try {
    const response = await fetch("/api/entries");
    if (!response.ok) {
      throw new Error(`Entry request failed with status ${response.status}.`);
    }
    entries = (await response.json()) as ClientEntry[];
    renderEntries();
  } catch (error) {
    console.error(error);
  }
}

async function loadSessions(): Promise<void> {
  if (sessionsLoading) {
    return;
  }
  sessionsLoading = true;
  try {
    const response = await fetch("/api/sessions", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `Session request failed with status ${response.status}.`,
      );
    }
    sessions = (await response.json()) as ClientSession[];
    renderSessions();
  } catch (error) {
    console.error(error);
  } finally {
    sessionsLoading = false;
  }
}

async function addEntry(): Promise<void> {
  addButton.disabled = true;
  try {
    const response = await fetch("/api/entries", { method: "POST" });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Registration failed with status ${response.status}.`);
    }
    if (response.status !== 204) {
      await loadEntries();
    }
  } catch (error) {
    console.error(error);
  } finally {
    addButton.disabled = false;
  }
}

async function setEntryPinned(
  entry: ClientEntry,
  pinned: boolean,
): Promise<void> {
  try {
    const response = await fetch(
      `/api/entries/${encodeURIComponent(entry.id)}/pin`,
      { method: pinned ? "POST" : "DELETE" },
    );
    if (!response.ok) {
      throw new Error(
        `Entry pin update failed with status ${response.status}.`,
      );
    }
    await loadEntries();
  } catch (error) {
    console.error(error);
  }
}

async function openEntryDetails(entry: ClientEntry): Promise<void> {
  detailsOrigin = desktop.querySelector<HTMLElement>(
    `[data-entry-id="${CSS.escape(entry.id)}"]`,
  );
  closeContextMenu();

  try {
    const response = await fetch(
      `/api/entries/${encodeURIComponent(entry.id)}`,
    );
    if (!response.ok) {
      throw new Error(`Entry details failed with status ${response.status}.`);
    }
    managedEntry = (await response.json()) as EntryDetails;
    populateEntryDetails(managedEntry);
    detailsDialog.showModal();
    closeDetailsButton.focus();
  } catch (error) {
    detailsOrigin = null;
    console.error(error);
  }
}

function populateEntryDetails(entry: EntryDetails): void {
  detailsTitle.textContent = entry.name;
  detailLocation.textContent = entry.location;
  detailEnvironment.textContent =
    entry.environment.kind === "windows"
      ? "Windows"
      : `WSL · ${entry.environment.distribution}`;
  detailAvailability.textContent = entry.available
    ? "Available"
    : "Unavailable";
  detailDefault.textContent =
    entry.defaultAction === "folder"
      ? "Open folder"
      : entry.defaultAction === "terminal"
        ? "Open terminal"
        : entry.actions.find(
              (action) => action.id === entry.defaultAction,
            )?.label ?? "None";
  detailMetadata.textContent = metadataStatusLabel(entry.metadataStatus);
  detailIcon.textContent =
    entry.iconSource.kind === "custom"
      ? "Custom .hbox/icon.svg"
      : entry.iconSource.kind === "tag"
        ? `Built-in tag · ${entry.iconSource.tag}`
        : "Fallback";
  detailId.textContent = entry.id;

  if (entry.tags.length === 0) {
    const empty = document.createElement("span");
    empty.className = "detail-empty";
    empty.textContent = "None";
    detailTags.replaceChildren(empty);
  } else {
    detailTags.replaceChildren(
      ...entry.tags.map((tag) => {
        const pill = document.createElement("span");
        pill.className = "detail-tag";
        pill.textContent = tag;
        return pill;
      }),
    );
  }
}

async function removeManagedEntry(): Promise<void> {
  if (!managedEntry) {
    return;
  }

  const entryId = managedEntry.id;
  removeEntryButton.disabled = true;
  try {
    const response = await fetch(
      `/api/entries/${encodeURIComponent(entryId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      throw new Error(`Entry removal failed with status ${response.status}.`);
    }

    entries = entries.filter((entry) => entry.id !== entryId);
    detailsDialog.close();
    renderEntries();
    desktop.focus();
  } catch (error) {
    console.error(error);
    removeEntryButton.disabled = false;
  }
}

function metadataStatusLabel(status: MetadataStatus): string {
  switch (status) {
    case "loaded":
      return "Loaded";
    case "not_found":
      return "Not found";
    case "invalid":
      return "Invalid";
    case "unreadable":
      return "Unreadable";
    case "folder_unavailable":
      return "Folder unavailable";
  }
}

function renderEntries(): void {
  const visibleEntries = entries.filter((entry) =>
    matchesEntry(entry, searchInput.value),
  );
  const visiblePinned = visibleEntries
    .filter((entry) => entry.pinnedPosition !== null)
    .sort((left, right) => left.pinnedPosition! - right.pinnedPosition!);

  pinnedEntries.replaceChildren(
    ...visiblePinned.map((entry) => createEntryElement(entry, true)),
  );
  allEntries.replaceChildren(
    ...visibleEntries.map((entry) => createEntryElement(entry, false)),
  );
  pinnedSection.hidden = visiblePinned.length === 0;
  allSection.hidden = visibleEntries.length === 0;
}

function createEntryElement(
  entry: ClientEntry,
  pinnedCopy: boolean,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `entry${entry.available ? "" : " unavailable"}`;
  element.dataset.entryId = entry.id;
  element.draggable = pinnedCopy;
  element.setAttribute(
    "aria-label",
    entry.available ? entry.name : `${entry.name}, unavailable`,
  );
  if (!entry.available) {
    element.setAttribute("aria-disabled", "true");
  }

  const folder = document.createElement("span");
  folder.className = "folder";
  const folderImage = document.createElement("img");
  folderImage.className = "folder-shape";
  folderImage.src = "/assets/icons/folder.svg";
  folderImage.alt = "";
  folder.append(folderImage);
  const icon = createEntryIcon(entry);
  if (icon) {
    folder.append(icon);
  }

  const label = document.createElement("span");
  label.className = "entry-label";
  label.textContent = entry.name;

  element.append(folder, label);
  element.addEventListener("click", () => {
    if (!entry.available) {
      return;
    }
    if (entry.defaultAction) {
      void runAction(entry, entry.defaultAction);
    } else {
      const bounds = element.getBoundingClientRect();
      openContextMenu(entry, bounds.left + 32, bounds.top + 70);
    }
  });
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(entry, event.clientX, event.clientY);
  });
  if (pinnedCopy) {
    element.addEventListener("dragstart", (event) => {
      draggedPinnedElement = element;
      element.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.id);
      }
    });
  }

  return element;
}

function createEntryIcon(entry: ClientEntry): HTMLElement | null {
  const icon = document.createElement("span");
  icon.className = "entry-icon";

  if (entry.hasCustomIcon) {
    icon.classList.add("custom-icon");
    const image = document.createElement("img");
    image.src = `/api/entries/${encodeURIComponent(entry.id)}/icon`;
    image.alt = "";
    icon.append(image);
    return icon;
  }

  const tagIcon = tagIconFor(entry);
  const image = document.createElement("img");
  image.src = tagIcon
    ? tagIconUrls[tagIcon]
    : "/assets/icons/fallback.svg";
  image.alt = "";
  icon.append(image);
  return icon;
}

function openContextMenu(entry: ClientEntry, x: number, y: number): void {
  closeConfigMenu();
  contextEntry = entry;
  customActions.replaceChildren(
    ...entry.actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.action = action.id;
      button.textContent = action.label;
      button.disabled = !entry.available;
      return button;
    }),
  );
  for (const button of contextMenu.querySelectorAll<HTMLButtonElement>(
    "button[data-action]",
  )) {
    button.disabled = !entry.available;
  }
  pinEntryButton.textContent =
    entry.pinnedPosition === null ? "Pin to top" : "Unpin from top";

  contextMenu.hidden = false;
  const bounds = contextMenu.getBoundingClientRect();
  const margin = 8;
  contextMenu.style.left = `${Math.max(
    margin,
    Math.min(x, window.innerWidth - bounds.width - margin),
  )}px`;
  contextMenu.style.top = `${Math.max(
    margin,
    Math.min(y, window.innerHeight - bounds.height - margin),
  )}px`;
}

async function persistVisiblePinOrder(): Promise<void> {
  const currentOrder = entries
    .filter((entry) => entry.pinnedPosition !== null)
    .sort((left, right) => left.pinnedPosition! - right.pinnedPosition!)
    .map((entry) => entry.id);
  const visibleOrder = [
    ...pinnedEntries.querySelectorAll<HTMLElement>("[data-entry-id]"),
  ].map((element) => element.dataset.entryId!);
  const nextOrder = mergeVisiblePinOrder(currentOrder, visibleOrder);
  const positions = new Map(
    nextOrder.map((entryId, index) => [entryId, index]),
  );
  entries = entries.map((entry) => ({
    ...entry,
    pinnedPosition: positions.get(entry.id) ?? null,
  }));
  renderEntries();

  try {
    const response = await fetch("/api/pins/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: nextOrder }),
    });
    if (!response.ok) {
      throw new Error(`Pin reorder failed with status ${response.status}.`);
    }
  } catch (error) {
    console.error(error);
    await loadEntries();
  }
}

function closeContextMenu(): void {
  contextMenu.hidden = true;
  contextEntry = null;
}

function toggleConfigMenu(): void {
  const shouldOpen = configMenu.hidden;
  closeContextMenu();
  configMenu.hidden = !shouldOpen;
  configButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    restartButton.focus();
  }
}

function closeConfigMenu(): void {
  configMenu.hidden = true;
  configButton.setAttribute("aria-expanded", "false");
}

async function restartServer(): Promise<void> {
  restartButton.disabled = true;
  try {
    const response = await fetch("/api/restart", { method: "POST" });
    if (!response.ok) {
      throw new Error(`Restart failed with status ${response.status}.`);
    }
    const current = (await response.json()) as { instanceId: string };
    await waitForServer(current.instanceId);
    window.location.reload();
  } catch (error) {
    console.error(error);
    restartButton.disabled = false;
  }
}

async function waitForServer(previousInstanceId: string): Promise<void> {
  await delay(300);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
      });
      if (response.ok) {
        const status = (await response.json()) as { instanceId: string };
        if (status.instanceId !== previousInstanceId) {
          return;
        }
      }
    } catch {
      // The old listener is closed while its replacement starts.
    }
    await delay(250);
  }
  throw new Error("HBOX did not return after restart.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runAction(
  entry: ClientEntry,
  action: ActionName,
): Promise<void> {
  closeContextMenu();
  if (!entry.available) {
    return;
  }

  if (isBuiltInAction(action) && entry.nativeLaunch) {
    window.location.assign(entry.nativeLaunch[action]);
    return;
  }

  try {
    const response = await fetch(
      `/api/entries/${encodeURIComponent(entry.id)}/actions/${encodeURIComponent(action)}`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(`Action failed with status ${response.status}.`);
    }
    await loadSessions();
  } catch (error) {
    console.error(error);
  }
}

function isBuiltInAction(action: string): action is BuiltInActionName {
  return action === "folder" || action === "terminal";
}

function setSessionsPaneOpen(open: boolean): void {
  closeContextMenu();
  closeConfigMenu();
  sessionsPane.hidden = !open;
  document.body.classList.toggle("sessions-open", open);
  sessionsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    void loadSessions();
  }
}

function renderSessions(): void {
  sessionCount.hidden = sessions.length === 0;
  sessionCount.textContent =
    sessions.length > 99 ? "99+" : String(sessions.length);
  sessionsButton.setAttribute(
    "aria-label",
    sessions.length === 0
      ? "Sessions"
      : `Sessions, ${sessions.length} ongoing or unresolved`,
  );
  sessionList.replaceChildren(
    ...sessions.map(createSessionElement),
  );
}

function createSessionElement(session: ClientSession): HTMLElement {
  const item = document.createElement("article");
  item.className = "session-item";
  item.dataset.status = session.status;

  const identity = document.createElement("div");
  identity.className = "session-identity";
  const name = document.createElement("div");
  name.className = "session-name";
  name.textContent = session.name;
  const entry = document.createElement("div");
  entry.className = "session-entry";
  entry.textContent = session.entryName;
  identity.append(entry, name);

  const state = document.createElement("div");
  state.className = "session-state";
  const status = document.createElement("div");
  status.className = "session-status";
  status.textContent = sessionStatusLabel(session.status);
  const secondary = document.createElement("div");
  secondary.className = session.message
    ? "session-message"
    : "session-age";
  secondary.textContent =
    session.message ?? `Started ${relativeTime(session.startedAt)}`;
  secondary.title = session.message ?? session.startedAt;
  state.append(status, secondary);

  const actions = document.createElement("div");
  actions.className = "session-actions";
  if (session.canOpen) {
    actions.append(sessionActionButton(session, "Open", "open"));
  }
  if (session.canStop) {
    actions.append(sessionActionButton(session, "Stop", "stop"));
  }
  if (session.canRestart) {
    actions.append(
      sessionActionButton(session, "Restart", "restart"),
    );
  }
  if (session.canRecheck) {
    actions.append(
      sessionActionButton(session, "Check again", "recheck"),
    );
  }
  if (session.canForget) {
    actions.append(
      sessionActionButton(session, "Forget", "forget"),
    );
  }

  item.append(identity, state, actions);
  return item;
}

function sessionActionButton(
  session: ClientSession,
  label: string,
  action: "open" | "stop" | "restart" | "recheck" | "forget",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    button.disabled = true;
    void performSessionAction(session.id, action);
  });
  return button;
}

async function performSessionAction(
  sessionId: string,
  action: "open" | "stop" | "restart" | "recheck" | "forget",
): Promise<void> {
  try {
    const response = await fetch(
      action === "forget"
        ? `/api/sessions/${encodeURIComponent(sessionId)}`
        : `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
      { method: action === "forget" ? "DELETE" : "POST" },
    );
    if (!response.ok) {
      throw new Error(
        `Session ${action} failed with status ${response.status}.`,
      );
    }
  } catch (error) {
    console.error(error);
  } finally {
    await loadSessions();
  }
}

function sessionStatusLabel(
  status: ClientSession["status"],
): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "degraded":
      return "Degraded";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Failed";
    case "disconnected":
      return "Disconnected";
  }
}

function relativeTime(startedAt: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(startedAt)) / 1_000),
  );
  if (elapsedSeconds < 60) {
    return elapsedSeconds < 2 ? "just now" : `${elapsedSeconds}s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

function hideSearch(): void {
  searchInput.value = "";
  searchShell.hidden = true;
  searchInput.blur();
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}
