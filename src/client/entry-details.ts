import { ApiClient } from "./api-client.js";
import { requiredElement } from "./dom.js";
import type {
  ClientEntry,
  EntryDetails,
  MetadataStatus,
} from "./model.js";

export class EntryDetailsView {
  readonly dialog =
    requiredElement<HTMLDialogElement>("entry-details-dialog");
  private readonly desktop = requiredElement<HTMLElement>("desktop");
  private readonly title =
    requiredElement<HTMLElement>("entry-details-title");
  private readonly closeButton =
    requiredElement<HTMLButtonElement>("close-entry-details");
  private readonly removeButton =
    requiredElement<HTMLButtonElement>("remove-entry");
  private readonly location =
    requiredElement<HTMLElement>("entry-detail-location");
  private readonly environment =
    requiredElement<HTMLElement>("entry-detail-environment");
  private readonly availability =
    requiredElement<HTMLElement>("entry-detail-availability");
  private readonly tags = requiredElement<HTMLElement>("entry-detail-tags");
  private readonly defaultAction =
    requiredElement<HTMLElement>("entry-detail-default");
  private readonly metadata =
    requiredElement<HTMLElement>("entry-detail-metadata");
  private readonly icon = requiredElement<HTMLElement>("entry-detail-icon");
  private readonly id = requiredElement<HTMLElement>("entry-detail-id");
  private entry: EntryDetails | null = null;
  private origin: HTMLElement | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly onRemoved: (entryId: string) => void,
  ) {
    this.closeButton.addEventListener("click", () => this.dialog.close());
    this.removeButton.addEventListener(
      "click",
      () => void this.removeEntry(),
    );
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) {
        this.dialog.close();
      }
    });
    this.dialog.addEventListener("close", () => {
      this.entry = null;
      this.removeButton.disabled = false;
      const origin = this.origin;
      this.origin = null;
      if (origin?.isConnected) {
        origin.focus();
      }
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    this.dialog.close();
  }

  async open(entry: ClientEntry): Promise<void> {
    this.origin = this.desktop.querySelector<HTMLElement>(
      `[data-entry-id="${CSS.escape(entry.id)}"]`,
    );
    try {
      this.entry = await this.api.entryDetails(entry.id);
      this.populate(this.entry);
      this.dialog.showModal();
      this.closeButton.focus();
    } catch (error) {
      this.origin = null;
      console.error(error);
    }
  }

  private populate(entry: EntryDetails): void {
    this.title.textContent = entry.name;
    this.location.textContent = entry.location;
    this.environment.textContent =
      entry.environment.kind === "windows"
        ? "Windows"
        : `WSL · ${entry.environment.distribution}`;
    this.availability.textContent = entry.available
      ? "Available"
      : "Unavailable";
    this.defaultAction.textContent =
      entry.defaultAction === "folder"
        ? "Open folder"
        : entry.defaultAction === "terminal"
          ? "Open terminal"
          : entry.actions.find(
                (action) => action.id === entry.defaultAction,
              )?.label ?? "None";
    this.metadata.textContent = metadataStatusLabel(entry.metadataStatus);
    this.icon.textContent =
      entry.iconSource.kind === "custom"
        ? "Custom .hbox/icon.svg"
        : entry.iconSource.kind === "tag"
          ? `Built-in tag · ${entry.iconSource.tag}`
          : "Fallback";
    this.id.textContent = entry.id;

    if (entry.tags.length === 0) {
      const empty = document.createElement("span");
      empty.className = "detail-empty";
      empty.textContent = "None";
      this.tags.replaceChildren(empty);
    } else {
      this.tags.replaceChildren(
        ...entry.tags.map((tag) => {
          const pill = document.createElement("span");
          pill.className = "detail-tag";
          pill.textContent = tag;
          return pill;
        }),
      );
    }
  }

  private async removeEntry(): Promise<void> {
    if (!this.entry) {
      return;
    }
    const entryId = this.entry.id;
    this.removeButton.disabled = true;
    try {
      await this.api.removeEntry(entryId);
      this.onRemoved(entryId);
      this.dialog.close();
      this.desktop.focus();
    } catch (error) {
      console.error(error);
      this.removeButton.disabled = false;
    }
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
