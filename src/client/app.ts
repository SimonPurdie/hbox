import { ApiClient } from "./api-client.js";
import { EntriesView } from "./entries-view.js";
import { EntryDetailsView } from "./entry-details.js";
import { PreferencesView } from "./preferences-view.js";
import { SessionsView } from "./sessions-view.js";

const api = new ApiClient();
let entries!: EntriesView;
let preferences!: PreferencesView;

const sessions = new SessionsView(api, () => {
  entries.closeContextMenu();
  preferences.close();
});
const details = new EntryDetailsView(api, (entryId) => {
  entries.removeFromState(entryId);
});
preferences = new PreferencesView(api, () => {
  entries.closeContextMenu();
});
entries = new EntriesView(
  api,
  (entry) => void details.open(entry),
  async () => sessions.load(),
  () => preferences.close(),
);

document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (entries.contextOpen && !entries.contextMenu.contains(target)) {
    entries.closeContextMenu();
  }
  if (
    preferences.isOpen &&
    !preferences.menu.contains(target) &&
    !preferences.button.contains(target)
  ) {
    preferences.close();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (details.isOpen) {
      return;
    }
    if (entries.contextOpen) {
      entries.closeContextMenu();
      return;
    }
    if (preferences.isOpen) {
      preferences.close();
      return;
    }
    if (sessions.isOpen) {
      sessions.close();
      sessions.button.focus();
      return;
    }
    if (!entries.searchShell.hidden) {
      event.preventDefault();
      entries.hideSearch();
      entries.refreshSearch();
    }
    return;
  }

  if (
    entries.contextOpen ||
    preferences.isOpen ||
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
  entries.appendSearchCharacter(event.key);
});

window.addEventListener("resize", () => {
  entries.closeContextMenu();
  preferences.close();
});
