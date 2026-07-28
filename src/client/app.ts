import {
  matchesEntry,
  tagIconFor,
  type ActionName,
  type ClientEntry,
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
const contextMenu = requiredElement<HTMLElement>("context-menu");
const searchShell = requiredElement<HTMLElement>("search-shell");
const searchInput = requiredElement<HTMLInputElement>("search");

let entries: ClientEntry[] = [];
let contextEntry: ClientEntry | null = null;

addButton.addEventListener("click", () => void addEntry());
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
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!contextMenu.hidden) {
      closeContextMenu();
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

window.addEventListener("resize", closeContextMenu);
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
