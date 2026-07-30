import type {
  ActionName,
  ClientEntry,
  ClientSession,
  EntryDetails,
  InstanceStatus,
  PinOrderRequest,
  PreferencesDto,
} from "./model.js";

export type SessionAction =
  | "open"
  | "stop"
  | "restart"
  | "recheck"
  | "forget";

export class ApiClient {
  async preferences(): Promise<PreferencesDto> {
    return await getJson("/api/preferences", "Preference", {
      cache: "no-store",
    });
  }

  async savePreferences(preferences: PreferencesDto): Promise<void> {
    await requireOk(
      "/api/preferences",
      "Preference update",
      jsonRequest("PUT", preferences),
    );
  }

  async entries(): Promise<ClientEntry[]> {
    return await getJson("/api/entries", "Entry");
  }

  async addEntry(): Promise<boolean> {
    const response = await fetch("/api/entries", { method: "POST" });
    if (!response.ok && response.status !== 204) {
      throw requestError("Registration", response);
    }
    return response.status !== 204;
  }

  async setEntryPinned(entryId: string, pinned: boolean): Promise<void> {
    await requireOk(
      `/api/entries/${encodeURIComponent(entryId)}/pin`,
      "Entry pin update",
      { method: pinned ? "POST" : "DELETE" },
    );
  }

  async entryDetails(entryId: string): Promise<EntryDetails> {
    return await getJson(
      `/api/entries/${encodeURIComponent(entryId)}`,
      "Entry details",
    );
  }

  async removeEntry(entryId: string): Promise<void> {
    await requireOk(
      `/api/entries/${encodeURIComponent(entryId)}`,
      "Entry removal",
      { method: "DELETE" },
    );
  }

  async savePinOrder(entryIds: string[]): Promise<void> {
    const request: PinOrderRequest = { entryIds };
    await requireOk(
      "/api/pins/order",
      "Pin reorder",
      jsonRequest("PUT", request),
    );
  }

  async runEntryAction(
    entryId: string,
    action: ActionName,
  ): Promise<void> {
    await requireOk(
      `/api/entries/${encodeURIComponent(entryId)}/actions/${encodeURIComponent(action)}`,
      "Action",
      { method: "POST" },
    );
  }

  async sessions(): Promise<ClientSession[]> {
    return await getJson("/api/sessions", "Session", {
      cache: "no-store",
    });
  }

  async performSessionAction(
    sessionId: string,
    action: SessionAction,
  ): Promise<void> {
    await requireOk(
      action === "forget"
        ? `/api/sessions/${encodeURIComponent(sessionId)}`
        : `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
      `Session ${action}`,
      { method: action === "forget" ? "DELETE" : "POST" },
    );
  }

  async restart(): Promise<InstanceStatus> {
    return await getJson(
      "/api/restart",
      "Restart",
      { method: "POST" },
    );
  }

  async status(): Promise<InstanceStatus> {
    return await getJson("/api/status", "Status", {
      cache: "no-store",
    });
  }
}

function jsonRequest(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function getJson<T>(
  url: string,
  operation: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw requestError(operation, response);
  }
  return await response.json() as T;
}

async function requireOk(
  url: string,
  operation: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw requestError(operation, response);
  }
}

function requestError(operation: string, response: Response): Error {
  return new Error(`${operation} failed with status ${response.status}.`);
}
