import {
  ApiClient,
  type SessionAction,
} from "./api-client.js";
import { requiredElement } from "./dom.js";
import type { ClientSession } from "./model.js";

export class SessionsView {
  readonly button =
    requiredElement<HTMLButtonElement>("open-sessions");
  readonly pane = requiredElement<HTMLElement>("sessions-pane");
  private readonly count = requiredElement<HTMLElement>("session-count");
  private readonly closeButton =
    requiredElement<HTMLButtonElement>("close-sessions");
  private readonly list = requiredElement<HTMLElement>("session-list");
  private sessions: ClientSession[] = [];
  private loading = false;

  constructor(
    private readonly api: ApiClient,
    private readonly beforeOpen: () => void,
  ) {
    this.button.addEventListener("click", () => {
      this.setOpen(this.pane.hidden);
    });
    this.closeButton.addEventListener("click", () => {
      this.close();
      this.button.focus();
    });
    void this.load();
    window.setInterval(() => void this.load(), 2_000);
  }

  get isOpen(): boolean {
    return !this.pane.hidden;
  }

  setOpen(open: boolean): void {
    if (open) {
      this.beforeOpen();
    }
    this.pane.hidden = !open;
    document.body.classList.toggle("sessions-open", open);
    this.button.setAttribute("aria-expanded", String(open));
    if (open) {
      void this.load();
    }
  }

  close(): void {
    this.setOpen(false);
  }

  async load(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      this.sessions = await this.api.sessions();
      this.render();
    } catch (error) {
      console.error(error);
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    this.count.hidden = this.sessions.length === 0;
    this.count.textContent =
      this.sessions.length > 99 ? "99+" : String(this.sessions.length);
    this.button.setAttribute(
      "aria-label",
      this.sessions.length === 0
        ? "Sessions"
        : `Sessions, ${this.sessions.length} ongoing or unresolved`,
    );
    this.list.replaceChildren(
      ...this.sessions.map((session) => this.createSessionElement(session)),
    );
  }

  private createSessionElement(session: ClientSession): HTMLElement {
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
      actions.append(this.actionButton(session, "Open", "open"));
    }
    if (session.canStop) {
      actions.append(this.actionButton(session, "Stop", "stop"));
    }
    if (session.canRestart) {
      actions.append(this.actionButton(session, "Restart", "restart"));
    }
    if (session.canRecheck) {
      actions.append(
        this.actionButton(session, "Check again", "recheck"),
      );
    }
    if (session.canForget) {
      actions.append(this.actionButton(session, "Forget", "forget"));
    }

    item.append(identity, state, actions);
    return item;
  }

  private actionButton(
    session: ClientSession,
    label: string,
    action: SessionAction,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.performAction(session.id, action);
    });
    return button;
  }

  private async performAction(
    sessionId: string,
    action: SessionAction,
  ): Promise<void> {
    try {
      await this.api.performSessionAction(sessionId, action);
    } catch (error) {
      console.error(error);
    } finally {
      await this.load();
    }
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
