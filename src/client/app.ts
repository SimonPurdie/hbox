import {
  matchesEntry,
  tagIconFor,
  type ActionName,
  type ClientEntry,
  type EntryDetails,
  type MetadataStatus,
  type TagIcon,
} from "./model.js";

const tagIconUrls: Record<TagIcon, string> = {
  agent: "/assets/icons/tag-agent.svg",
  app: "/assets/icons/tag-app.svg",
  code: "/assets/icons/tag-code.svg",
  script: "/assets/icons/tag-script.svg",
  tool: "/assets/icons/tag-tool.svg",
  web: "/assets/icons/tag-web.svg",
};

const desktop = requiredElement<HTMLElement>("desktop");
const addButton = requiredElement<HTMLButtonElement>("add-entry");
const configButton = requiredElement<HTMLButtonElement>("open-config");
const contextMenu = requiredElement<HTMLElement>("context-menu");
const manageEntryButton =
  requiredElement<HTMLButtonElement>("manage-entry");
const configMenu = requiredElement<HTMLElement>("config-menu");
const restartButton =
  requiredElement<HTMLButtonElement>("restart-server");
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

let entries: ClientEntry[] = [];
let contextEntry: ClientEntry | null = null;
let managedEntry: EntryDetails | null = null;
let detailsOrigin: HTMLElement | null = null;

addButton.addEventListener("click", () => void addEntry());
configButton.addEventListener("click", toggleConfigMenu);
restartButton.addEventListener("click", () => void restartServer());
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
        : "None";
  detailMetadata.textContent = metadataStatusLabel(entry.metadataStatus);
  detailIcon.textContent =
    entry.iconSource.kind === "custom"
      ? "Custom .hbox/icon.svg"
      : entry.iconSource.kind === "tag"
        ? `Built-in tag · ${entry.iconSource.tag}`
        : "None";
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
  const fragment = document.createDocumentFragment();

  for (const entry of visibleEntries) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `entry${entry.available ? "" : " unavailable"}`;
    element.dataset.entryId = entry.id;
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

    fragment.append(element);
  }

  desktop.replaceChildren(fragment);
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
  if (!tagIcon) {
    return null;
  }
  const image = document.createElement("img");
  image.src = tagIconUrls[tagIcon];
  image.alt = "";
  icon.append(image);
  return icon;
}

function openContextMenu(entry: ClientEntry, x: number, y: number): void {
  closeConfigMenu();
  contextEntry = entry;
  for (const button of contextMenu.querySelectorAll<HTMLButtonElement>(
    "button[data-action]",
  )) {
    button.disabled = !entry.available;
  }

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
    await waitForServer();
    window.location.reload();
  } catch (error) {
    console.error(error);
    restartButton.disabled = false;
  }
}

async function waitForServer(): Promise<void> {
  await delay(300);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("/api/entries", {
        cache: "no-store",
      });
      if (response.ok) {
        return;
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

  try {
    const response = await fetch(
      `/api/entries/${encodeURIComponent(entry.id)}/actions/${action}`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(`Action failed with status ${response.status}.`);
    }
  } catch (error) {
    console.error(error);
  }
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
