import { ApiClient } from "./api-client.js";
import { requiredElement } from "./dom.js";
import {
  mergeVisiblePinOrder,
  matchesEntry,
  tagIconFor,
  type ActionName,
  type BuiltInActionName,
  type ClientEntry,
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

export class EntriesView {
  readonly desktop = requiredElement<HTMLElement>("desktop");
  readonly contextMenu = requiredElement<HTMLElement>("context-menu");
  readonly searchShell = requiredElement<HTMLElement>("search-shell");
  readonly searchInput = requiredElement<HTMLInputElement>("search");
  private readonly pinnedSection =
    requiredElement<HTMLElement>("pinned-section");
  private readonly pinnedEntries =
    requiredElement<HTMLElement>("pinned-entries");
  private readonly allSection = requiredElement<HTMLElement>("all-section");
  private readonly allEntries = requiredElement<HTMLElement>("all-entries");
  private readonly addButton =
    requiredElement<HTMLButtonElement>("add-entry");
  private readonly customActions =
    requiredElement<HTMLElement>("custom-actions");
  private readonly pinButton =
    requiredElement<HTMLButtonElement>("pin-entry");
  private readonly manageButton =
    requiredElement<HTMLButtonElement>("manage-entry");
  private entries: ClientEntry[] = [];
  private contextEntry: ClientEntry | null = null;
  private draggedPinnedElement: HTMLButtonElement | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly openDetails: (entry: ClientEntry) => void,
    private readonly afterAction: () => Promise<void>,
    private readonly beforeContextOpen: () => void,
  ) {
    this.addButton.addEventListener("click", () => void this.addEntry());
    this.pinButton.addEventListener("click", () => {
      const entry = this.contextEntry;
      if (!entry) {
        return;
      }
      this.closeContextMenu();
      void this.setPinned(entry, entry.pinnedPosition === null);
    });
    this.manageButton.addEventListener("click", () => {
      if (this.contextEntry) {
        const entry = this.contextEntry;
        this.closeContextMenu();
        this.openDetails(entry);
      }
    });
    this.searchInput.addEventListener("input", () => {
      if (!this.searchInput.value) {
        this.hideSearch();
      }
      this.render();
    });
    this.contextMenu.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement)
        .closest<HTMLButtonElement>("button[data-action]");
      if (!target || target.disabled || !this.contextEntry) {
        return;
      }
      void this.runAction(
        this.contextEntry,
        target.dataset.action as ActionName,
      );
    });
    this.bindPinDragging();
    void this.load();
  }

  get contextOpen(): boolean {
    return !this.contextMenu.hidden;
  }

  async load(): Promise<void> {
    try {
      this.entries = await this.api.entries();
      this.render();
    } catch (error) {
      console.error(error);
    }
  }

  removeFromState(entryId: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== entryId);
    this.render();
  }

  closeContextMenu(): void {
    this.contextMenu.hidden = true;
    this.contextEntry = null;
  }

  hideSearch(): void {
    this.searchInput.value = "";
    this.searchShell.hidden = true;
    this.desktop.focus();
  }

  appendSearchCharacter(character: string): void {
    this.searchShell.hidden = false;
    this.searchInput.value += character;
    this.searchInput.focus();
    this.render();
  }

  refreshSearch(): void {
    this.render();
  }

  private async addEntry(): Promise<void> {
    this.addButton.disabled = true;
    try {
      if (await this.api.addEntry()) {
        await this.load();
      }
    } catch (error) {
      console.error(error);
    } finally {
      this.addButton.disabled = false;
    }
  }

  private async setPinned(
    entry: ClientEntry,
    pinned: boolean,
  ): Promise<void> {
    try {
      await this.api.setEntryPinned(entry.id, pinned);
      await this.load();
    } catch (error) {
      console.error(error);
    }
  }

  private render(): void {
    const visibleEntries = this.entries.filter((entry) =>
      matchesEntry(entry, this.searchInput.value),
    );
    const visiblePinned = visibleEntries
      .filter((entry) => entry.pinnedPosition !== null)
      .sort(
        (left, right) =>
          left.pinnedPosition! - right.pinnedPosition!,
      );

    this.pinnedEntries.replaceChildren(
      ...visiblePinned.map((entry) => this.createEntryElement(entry, true)),
    );
    this.allEntries.replaceChildren(
      ...visibleEntries.map((entry) => this.createEntryElement(entry, false)),
    );
    this.pinnedSection.hidden = visiblePinned.length === 0;
    this.allSection.hidden = visibleEntries.length === 0;
  }

  private createEntryElement(
    entry: ClientEntry,
    pinnedCopy: boolean,
  ): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = [
      "entry",
      entry.available ? "" : "unavailable",
      entry.defaultAction ? "has-default-action" : "",
    ]
      .filter(Boolean)
      .join(" ");
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
    folder.append(createFolderShape());
    folder.append(createEntryIcon(entry));

    const label = document.createElement("span");
    label.className = "entry-label";
    label.textContent = entry.name;

    element.append(folder, label);
    element.addEventListener("click", () => {
      if (!entry.available) {
        return;
      }
      if (entry.defaultAction) {
        void this.runAction(entry, entry.defaultAction);
      } else {
        const bounds = element.getBoundingClientRect();
        this.openContextMenu(entry, bounds.left + 32, bounds.top + 70);
      }
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openContextMenu(entry, event.clientX, event.clientY);
    });
    if (pinnedCopy) {
      element.addEventListener("dragstart", (event) => {
        this.draggedPinnedElement = element;
        element.classList.add("dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", entry.id);
        }
      });
    }
    return element;
  }

  private openContextMenu(entry: ClientEntry, x: number, y: number): void {
    this.beforeContextOpen();
    this.contextEntry = entry;
    this.customActions.replaceChildren(
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
    for (
      const button of this.contextMenu.querySelectorAll<HTMLButtonElement>(
        "button[data-action]",
      )
    ) {
      button.disabled = !entry.available;
    }
    this.pinButton.textContent =
      entry.pinnedPosition === null ? "Pin to top" : "Unpin from top";

    this.contextMenu.hidden = false;
    const bounds = this.contextMenu.getBoundingClientRect();
    const margin = 8;
    this.contextMenu.style.left = `${Math.max(
      margin,
      Math.min(x, window.innerWidth - bounds.width - margin),
    )}px`;
    this.contextMenu.style.top = `${Math.max(
      margin,
      Math.min(y, window.innerHeight - bounds.height - margin),
    )}px`;
  }

  private bindPinDragging(): void {
    this.pinnedEntries.addEventListener("dragover", (event) => {
      if (!this.draggedPinnedElement) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }

      const target = (event.target as HTMLElement)
        .closest<HTMLButtonElement>(".entry");
      if (!target || target === this.draggedPinnedElement) {
        if (!target) {
          this.pinnedEntries.append(this.draggedPinnedElement);
        }
        return;
      }

      const bounds = target.getBoundingClientRect();
      this.pinnedEntries.insertBefore(
        this.draggedPinnedElement,
        event.clientX < bounds.left + bounds.width / 2
          ? target
          : target.nextSibling,
      );
    });

    this.pinnedEntries.addEventListener("drop", (event) => {
      if (!this.draggedPinnedElement) {
        return;
      }
      event.preventDefault();
      const dragged = this.draggedPinnedElement;
      this.draggedPinnedElement = null;
      dragged.classList.remove("dragging");
      void this.persistVisiblePinOrder();
    });

    this.pinnedEntries.addEventListener("dragend", () => {
      if (!this.draggedPinnedElement) {
        return;
      }
      this.draggedPinnedElement.classList.remove("dragging");
      this.draggedPinnedElement = null;
      this.render();
    });
  }

  private async persistVisiblePinOrder(): Promise<void> {
    const currentOrder = this.entries
      .filter((entry) => entry.pinnedPosition !== null)
      .sort(
        (left, right) =>
          left.pinnedPosition! - right.pinnedPosition!,
      )
      .map((entry) => entry.id);
    const visibleOrder = [
      ...this.pinnedEntries.querySelectorAll<HTMLElement>("[data-entry-id]"),
    ].map((element) => element.dataset.entryId!);
    const nextOrder = mergeVisiblePinOrder(currentOrder, visibleOrder);
    const positions = new Map(
      nextOrder.map((entryId, index) => [entryId, index]),
    );
    this.entries = this.entries.map((entry) => ({
      ...entry,
      pinnedPosition: positions.get(entry.id) ?? null,
    }));
    this.render();

    try {
      await this.api.savePinOrder(nextOrder);
    } catch (error) {
      console.error(error);
      await this.load();
    }
  }

  private async runAction(
    entry: ClientEntry,
    action: ActionName,
  ): Promise<void> {
    this.closeContextMenu();
    if (!entry.available) {
      return;
    }
    if (isBuiltInAction(action) && entry.nativeLaunch) {
      window.location.assign(entry.nativeLaunch[action]);
      return;
    }
    try {
      await this.api.runEntryAction(entry.id, action);
      await this.afterAction();
    } catch (error) {
      console.error(error);
    }
  }
}

function createFolderShape(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const folder = document.createElementNS(namespace, "svg");
  folder.classList.add("folder-shape");
  folder.setAttribute("viewBox", "0 0 90 72");
  folder.setAttribute("aria-hidden", "true");
  folder.setAttribute("focusable", "false");

  const rear = document.createElementNS(namespace, "path");
  rear.classList.add("folder-rear");
  rear.setAttribute(
    "d",
    "M10 14a5 5 0 0 1 5-5h17l8 9h35a5 5 0 0 1 5 5v39a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5Z",
  );

  const front = document.createElementNS(namespace, "path");
  front.classList.add("folder-front");
  front.setAttribute(
    "d",
    "M10 29a5 5 0 0 1 5-5h60a5 5 0 0 1 5 5v33a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5Z",
  );
  folder.append(rear, front);
  return folder;
}

function createEntryIcon(entry: ClientEntry): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "entry-icon";
  const tagIcon = tagIconFor(entry);
  const iconUrl = entry.hasCustomIcon
    ? `/api/entries/${encodeURIComponent(entry.id)}/icon`
    : tagIcon
      ? tagIconUrls[tagIcon]
      : "/assets/icons/fallback.svg";
  icon.style.setProperty("--entry-icon-mask", `url("${iconUrl}")`);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function isBuiltInAction(action: string): action is BuiltInActionName {
  return action === "folder" || action === "terminal";
}
