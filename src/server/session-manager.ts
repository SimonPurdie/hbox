import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActionLauncher } from "./launcher.js";
import {
  type StoredSession,
  SessionStore,
} from "./session-store.js";
import type {
  ClientSession,
  ProcessSessionDefinition,
  StoredEntry,
  WslLocation,
} from "./types.js";
import type {
  RuntimeInspection,
  SessionRuntime,
} from "./wsl-session-runtime.js";

const RUNNER_START_GRACE_MS = 10_000;
const READINESS_START_GRACE_MS = 60_000;
const GRACEFUL_STOP_MS = 8_000;

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

export class SessionConflictError extends Error {}
export class SessionActionUnavailableError extends Error {}

export interface SessionManagerOptions {
  pollIntervalMs?: number;
  now?: () => Date;
  probeUrl?: (url: string) => Promise<boolean>;
  warn?: (message: string) => void;
}

export class SessionManager {
  private sessions: StoredSession[] = [];
  private queue: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly probeUrl: (url: string) => Promise<boolean>;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly store: SessionStore,
    private readonly runtime: SessionRuntime,
    private readonly launcher: Pick<ActionLauncher, "openUrl">,
    options: SessionManagerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.probeUrl = options.probeUrl ?? probeHttpUrl;
    this.warn = options.warn ?? console.warn;
  }

  async initialize(): Promise<void> {
    this.sessions = await this.store.load();
    await this.reconcileNow();
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.reconcileNow().catch((error: unknown) => {
          this.warn(`Could not reconcile Sessions: ${errorMessage(error)}`);
        });
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    }
  }

  close(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async listSessions(): Promise<ClientSession[]> {
    await this.queue;
    return this.sessions
      .map(toClientSession)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async startSession(
    entry: StoredEntry,
    definition: ProcessSessionDefinition,
  ): Promise<ClientSession> {
    return await this.exclusive(async () => {
      if (entry.location.kind !== "wsl") {
        throw new SessionActionUnavailableError(
          "Process Sessions currently require a WSL Entry.",
        );
      }

      if (definition.singleInstance) {
        const existing = this.sessions.find(
          (session) =>
            session.entryId === entry.id &&
            session.definitionId === definition.id &&
            session.status !== "failed",
        );
        if (existing) {
          if (
            existing.status === "running" ||
            existing.status === "degraded"
          ) {
            if (existing.definition.openUrl) {
              await this.launcher.openUrl(existing.definition.openUrl);
            }
            return toClientSession(existing);
          }
          if (existing.status === "starting") {
            existing.openPending = Boolean(existing.definition.openUrl);
            await this.store.save(this.sessions);
            return toClientSession(existing);
          }
          throw new SessionConflictError(
            "The existing Session must be resolved before another can start.",
          );
        }
      }

      const session = await this.createSession(
        entry.id,
        entry.lastKnown.name,
        entry.location,
        definition,
      );
      return toClientSession(session);
    });
  }

  async openSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const session = this.requireSession(sessionId);
      if (
        !session.definition.openUrl ||
        (session.status !== "running" &&
          session.status !== "degraded")
      ) {
        throw new SessionActionUnavailableError(
          "This Session cannot be opened.",
        );
      }
      await this.launcher.openUrl(session.definition.openUrl);
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const session = this.requireSession(sessionId);
      if (
        session.status !== "starting" &&
        session.status !== "running" &&
        session.status !== "degraded"
      ) {
        throw new SessionActionUnavailableError(
          "This Session cannot be stopped.",
        );
      }

      const inspection = await this.runtime.inspect(session);
      if (inspection.kind !== "alive") {
        await this.applyInspection(session, inspection);
        await this.store.save(this.sessions);
        throw new SessionActionUnavailableError(
          "HBOX could not verify the process before stopping it.",
        );
      }
      if (!(await this.runtime.stop(session, false))) {
        session.status = "disconnected";
        session.message =
          "HBOX could not verify the process while requesting shutdown.";
        await this.store.save(this.sessions);
        throw new SessionActionUnavailableError(session.message);
      }

      session.status = "stopping";
      session.stopRequestedAt = this.now().toISOString();
      session.restartPending = false;
      session.message = null;
      await this.store.save(this.sessions);
    });
  }

  async restartSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const session = this.requireSession(sessionId);
      if (session.status === "failed") {
        const snapshot = session;
        this.sessions = this.sessions.filter(
          (candidate) => candidate.id !== session.id,
        );
        await this.runtime.cleanup(snapshot);
        await this.createSession(
          snapshot.entryId,
          snapshot.entryName,
          snapshot.location,
          snapshot.definition,
          false,
        );
        await this.store.save(this.sessions);
        return;
      }
      if (
        session.status !== "starting" &&
        session.status !== "running" &&
        session.status !== "degraded"
      ) {
        throw new SessionActionUnavailableError(
          "This Session cannot be restarted.",
        );
      }

      const inspection = await this.runtime.inspect(session);
      if (
        inspection.kind !== "alive" ||
        !(await this.runtime.stop(session, false))
      ) {
        await this.applyInspection(session, inspection);
        if (inspection.kind === "alive") {
          session.status = "disconnected";
          session.message =
            "HBOX could not verify the process while requesting restart.";
        }
        await this.store.save(this.sessions);
        throw new SessionActionUnavailableError(
          "HBOX could not safely restart this Session.",
        );
      }

      session.status = "stopping";
      session.stopRequestedAt = this.now().toISOString();
      session.restartPending = true;
      session.message = null;
      await this.store.save(this.sessions);
    });
  }

  async forgetSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const session = this.requireSession(sessionId);
      if (
        session.status !== "failed" &&
        session.status !== "disconnected"
      ) {
        throw new SessionActionUnavailableError(
          "Only failed or disconnected Sessions can be forgotten.",
        );
      }
      this.sessions = this.sessions.filter(
        (candidate) => candidate.id !== session.id,
      );
      if (session.status === "failed") {
        await this.runtime.cleanup(session);
      }
      await this.store.save(this.sessions);
    });
  }

  async recheckSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const session = this.requireSession(sessionId);
      if (session.status !== "disconnected") {
        throw new SessionActionUnavailableError(
          "Only disconnected Sessions need a manual check.",
        );
      }
      const before = structuredClone(session);
      await this.reconcileSession(session);
      if (!isDeepStrictEqual(before, session)) {
        await this.store.save(this.sessions);
      }
    });
  }

  async reconcileNow(): Promise<void> {
    await this.exclusive(async () => {
      const before = structuredClone(this.sessions);
      for (const session of [...this.sessions]) {
        await this.reconcileSession(session);
      }
      if (!isDeepStrictEqual(before, this.sessions)) {
        await this.store.save(this.sessions);
      }
    });
  }

  private async reconcileSession(session: StoredSession): Promise<void> {
    if (session.status === "failed") {
      return;
    }

    const inspection = await this.runtime.inspect(session);
    await this.applyInspection(session, inspection);
  }

  private async applyInspection(
    session: StoredSession,
    inspection: RuntimeInspection,
  ): Promise<void> {
    if (inspection.kind === "disconnected") {
      session.status = "disconnected";
      session.message = inspection.reason;
      session.openPending = false;
      return;
    }

    if (inspection.kind === "pending") {
      if (ageMs(session.startedAt, this.now()) > RUNNER_START_GRACE_MS) {
        session.status = "disconnected";
        session.message = "The Session runner did not create identity data.";
        session.openPending = false;
      } else {
        session.status = "starting";
      }
      return;
    }

    if (
      inspection.kind === "exited" ||
      inspection.kind === "missing"
    ) {
      if (session.stopRequestedAt) {
        await this.finishStoppedSession(session);
        return;
      }
      session.status = "failed";
      session.message =
        inspection.kind === "exited"
          ? inspection.exitCode === null
            ? "The process exited without a readable exit code."
            : `The process exited with code ${inspection.exitCode}.`
          : "The process ended without recording an exit code.";
      session.openPending = false;
      return;
    }

    if (session.stopRequestedAt) {
      session.status = "stopping";
      if (
        ageMs(session.stopRequestedAt, this.now()) >= GRACEFUL_STOP_MS
      ) {
        const forced = await this.runtime.stop(session, true);
        session.message = forced
          ? "Graceful shutdown timed out. HBOX requested a forced stop."
          : "Graceful shutdown timed out, and HBOX could not verify a forced stop.";
        if (!forced) {
          session.status = "disconnected";
          session.openPending = false;
        }
      }
      return;
    }

    const ready = session.definition.readyUrl
      ? await this.probeUrl(session.definition.readyUrl)
      : true;
    if (ready) {
      session.status = "running";
      session.readyAt ??= this.now().toISOString();
      session.message = null;
      if (session.openPending && session.definition.openUrl) {
        session.openPending = false;
        try {
          await this.launcher.openUrl(session.definition.openUrl);
        } catch (error) {
          this.warn(
            `Could not open ${session.definition.openUrl}: ${errorMessage(error)}`,
          );
        }
      }
      return;
    }

    if (
      session.readyAt ||
      ageMs(session.startedAt, this.now()) >= READINESS_START_GRACE_MS
    ) {
      session.status = "degraded";
      session.message = session.readyAt
        ? "The process is running, but its readiness check is failing."
        : "The process is running, but it did not become ready.";
    } else {
      session.status = "starting";
      session.message = null;
    }
  }

  private async finishStoppedSession(
    session: StoredSession,
  ): Promise<void> {
    this.sessions = this.sessions.filter(
      (candidate) => candidate.id !== session.id,
    );
    await this.runtime.cleanup(session);
    if (session.restartPending) {
      await this.createSession(
        session.entryId,
        session.entryName,
        session.location,
        session.definition,
        false,
      );
    }
  }

  private async createSession(
    entryId: string,
    entryName: string,
    location: WslLocation,
    definition: ProcessSessionDefinition,
    save: boolean = true,
  ): Promise<StoredSession> {
    const session: StoredSession = {
      id: randomUUID(),
      entryId,
      entryName,
      definitionId: definition.id,
      definition: structuredClone(definition),
      location: structuredClone(location),
      status: "starting",
      startedAt: this.now().toISOString(),
      readyAt: null,
      message: null,
      openPending: Boolean(definition.openUrl),
      stopRequestedAt: null,
      restartPending: false,
    };
    this.sessions.push(session);
    if (save) {
      await this.store.save(this.sessions);
    }

    try {
      await this.runtime.start(session);
    } catch (error) {
      session.status = "failed";
      session.openPending = false;
      session.message = `Could not start the Session runner: ${errorMessage(error)}`;
      await this.store.save(this.sessions);
    }
    return session;
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function toClientSession(session: StoredSession): ClientSession {
  return {
    id: session.id,
    entryId: session.entryId,
    entryName: session.entryName,
    definitionId: session.definitionId,
    name: session.definition.label,
    status: session.status,
    startedAt: session.startedAt,
    readyAt: session.readyAt,
    url: session.definition.openUrl,
    message: session.message,
    canOpen:
      Boolean(session.definition.openUrl) &&
      (session.status === "running" || session.status === "degraded"),
    canStop:
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "degraded",
    canRestart:
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "degraded" ||
      session.status === "failed",
    canForget:
      session.status === "failed" || session.status === "disconnected",
    canRecheck: session.status === "disconnected",
  };
}

async function probeHttpUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

function ageMs(startedAt: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(startedAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
