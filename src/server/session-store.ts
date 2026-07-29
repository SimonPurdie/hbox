import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  ProcessSessionDefinition,
  SessionStatus,
  WslLocation,
} from "./types.js";

export const SESSION_STORE_VERSION = 1 as const;

export interface StoredSession {
  id: string;
  entryId: string;
  entryName: string;
  definitionId: string;
  definition: ProcessSessionDefinition;
  location: WslLocation;
  status: SessionStatus;
  startedAt: string;
  readyAt: string | null;
  message: string | null;
  openPending: boolean;
  stopRequestedAt: string | null;
  restartPending: boolean;
}

interface SessionStoreData {
  version: typeof SESSION_STORE_VERSION;
  sessions: StoredSession[];
}

export class SessionStore {
  readonly sessionsPath: string;

  constructor(private readonly dataDirectory: string) {
    this.sessionsPath = path.join(dataDirectory, "sessions.json");
  }

  async load(): Promise<StoredSession[]> {
    let raw: string;
    try {
      raw = await readFile(this.sessionsPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `HBOX Session store is not valid JSON: ${this.sessionsPath}`,
        { cause: error },
      );
    }
    if (!isSessionStoreData(value)) {
      throw new Error(
        `HBOX Session store has an unsupported or invalid structure: ${this.sessionsPath}`,
      );
    }
    return value.sessions;
  }

  async save(sessions: readonly StoredSession[]): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = `${this.sessionsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const data: SessionStoreData = {
      version: SESSION_STORE_VERSION,
      sessions: [...sessions],
    };
    await writeFile(
      temporaryPath,
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.sessionsPath);
  }
}

function isSessionStoreData(value: unknown): value is SessionStoreData {
  return (
    isRecord(value) &&
    value.version === SESSION_STORE_VERSION &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isStoredSession)
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    typeof value.entryId === "string" &&
    typeof value.entryName === "string" &&
    typeof value.definitionId === "string" &&
    isProcessSessionDefinition(value.definition) &&
    isWslLocation(value.location) &&
    isSessionStatus(value.status) &&
    isDateString(value.startedAt) &&
    isNullableDateString(value.readyAt) &&
    isNullableString(value.message) &&
    typeof value.openPending === "boolean" &&
    isNullableDateString(value.stopRequestedAt) &&
    typeof value.restartPending === "boolean"
  );
}

function isProcessSessionDefinition(
  value: unknown,
): value is ProcessSessionDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.type === "process" &&
    typeof value.label === "string" &&
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.every(
      (part) => typeof part === "string" && part.length > 0,
    ) &&
    isNullableString(value.readyUrl) &&
    isNullableString(value.openUrl) &&
    typeof value.singleInstance === "boolean"
  );
}

function isWslLocation(value: unknown): value is WslLocation {
  return (
    isRecord(value) &&
    value.kind === "wsl" &&
    typeof value.distribution === "string" &&
    value.distribution.length > 0 &&
    typeof value.path === "string" &&
    value.path.startsWith("/")
  );
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "starting" ||
    value === "running" ||
    value === "degraded" ||
    value === "stopping" ||
    value === "failed" ||
    value === "disconnected"
  );
}

function isDateString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNullableDateString(value: unknown): value is string | null {
  return value === null || isDateString(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
