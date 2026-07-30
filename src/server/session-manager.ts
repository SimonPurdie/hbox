import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mapConcurrent } from "./concurrency.js";
import type { ActionLauncher } from "./launcher.js";
import {
  type StoredSession,
  SessionStore,
} from "./session-store.js";
import type {
  ClientSession,
  EntryLocation,
  ProcessSessionDefinition,
  StoredEntry,
} from "./types.js";
import type {
  RuntimeInspection,
  SessionRuntime,
} from "./session-runtime.js";

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
  reconcileConcurrency?: number;
  now?: () => Date;
  probeUrl?: (url: string) => Promise<boolean>;
  warn?: (message: string) => void;
}

export class SessionManager {
  private sessions: StoredSession[] = [];
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private stateQueue: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private reconciliation: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly pollIntervalMs: number;
  private readonly reconcileConcurrency: number;
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
    this.reconcileConcurrency = options.reconcileConcurrency ?? 4;
    if (
      !Number.isSafeInteger(this.reconcileConcurrency) ||
      this.reconcileConcurrency < 1
    ) {
      throw new Error("Session reconciliation concurrency must be positive.");
    }
    this.now = options.now ?? (() => new Date());
    this.probeUrl = options.probeUrl ?? probeHttpUrl;
    this.warn = options.warn ?? console.warn;
  }

  async initialize(): Promise<void> {
    this.sessions = await this.store.load();
    this.closed = false;
    await this.reconcileNow();
    this.schedulePoll();
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async listSessions(): Promise<ClientSession[]> {
    return this.sessions
      .map(toClientSession)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async startSession(
    entry: StoredEntry,
    definition: ProcessSessionDefinition,
  ): Promise<ClientSession> {
    for (;;) {
      const selected = await this.withStateLock(async () => {
        const existing = definition.singleInstance
          ? this.sessions.find(
              (session) =>
                session.entryId === entry.id &&
                session.definitionId === definition.id &&
                session.status !== "failed",
            )
          : undefined;
        if (existing) {
          return { kind: "existing" as const, id: existing.id };
        }

        const session = this.addSession(
          entry.id,
          entry.lastKnown.name,
          entry.location,
          definition,
        );
        return { kind: "created" as const, id: session.id };
      });

      if (selected.kind === "created") {
        await this.persist();
        return await this.withSessionLock(selected.id, async () => {
          const session = this.requireSession(selected.id);
          await this.startRuntime(session);
          return toClientSession(session);
        });
      }

      const result = await this.withSessionLock(
        selected.id,
        async (): Promise<ClientSession | null> => {
          const existing = this.sessions.find(
            (candidate) => candidate.id === selected.id,
          );
          if (!existing) {
            return null;
          }
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
            await this.persist();
            return toClientSession(existing);
          }
          throw new SessionConflictError(
            "The existing Session must be resolved before another can start.",
          );
        },
      );
      if (result) {
        return result;
      }
    }
  }

  async openSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
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
    await this.withSessionLock(sessionId, async () => {
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
        await this.persist();
        throw new SessionActionUnavailableError(
          "HBOX could not verify the process before stopping it.",
        );
      }
      if (!(await this.runtime.stop(session, false))) {
        session.status = "disconnected";
        session.message =
          "HBOX could not verify the process while requesting shutdown.";
        await this.persist();
        throw new SessionActionUnavailableError(session.message);
      }

      session.status = "stopping";
      session.stopRequestedAt = this.now().toISOString();
      session.restartPending = false;
      session.message = null;
      await this.persist();
    });
  }

  async restartSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const session = this.requireSession(sessionId);
      if (session.status === "failed") {
        const snapshot = session;
        this.sessions = this.sessions.filter(
          (candidate) => candidate.id !== session.id,
        );
        await this.runtime.cleanup(snapshot);
        const replacement = this.addSession(
          snapshot.entryId,
          snapshot.entryName,
          snapshot.location,
          snapshot.definition,
        );
        await this.persist();
        await this.withSessionLock(replacement.id, async () => {
          await this.startRuntime(replacement);
        });
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
        await this.persist();
        throw new SessionActionUnavailableError(
          "HBOX could not safely restart this Session.",
        );
      }

      session.status = "stopping";
      session.stopRequestedAt = this.now().toISOString();
      session.restartPending = true;
      session.message = null;
      await this.persist();
    });
  }

  async forgetSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
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
      await this.persist();
    });
  }

  async recheckSession(sessionId: string): Promise<void> {
    const snapshot = await this.withSessionLock(sessionId, async () => {
      const current = this.requireSession(sessionId);
      if (current.status !== "disconnected") {
        throw new SessionActionUnavailableError(
          "Only disconnected Sessions need a manual check.",
        );
      }
      return structuredClone(current);
    });
    const inspection = await this.inspectSnapshot(snapshot);
    await this.withSessionLock(sessionId, async () => {
      const current = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (!current || !isDeepStrictEqual(current, snapshot)) {
        return;
      }
      await this.applyInspection(current, inspection.runtime, inspection.ready);
      await this.persist();
    });
  }

  async reconcileNow(): Promise<void> {
    if (this.reconciliation) {
      return await this.reconciliation;
    }

    const reconciliation = this.reconcileAll();
    this.reconciliation = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) {
        this.reconciliation = null;
      }
    }
  }

  private async reconcileAll(): Promise<void> {
    const sessionIds = this.sessions.map(({ id }) => id);
    await mapConcurrent(
      sessionIds,
      this.reconcileConcurrency,
      async (sessionId) => this.reconcileSession(sessionId),
    );
  }

  private async reconcileSession(sessionId: string): Promise<void> {
    const snapshot = await this.withSessionLock(
      sessionId,
      async (): Promise<StoredSession | null> => {
        const current = this.sessions.find(
          (candidate) => candidate.id === sessionId,
        );
        return current && current.status !== "failed"
          ? structuredClone(current)
          : null;
      },
    );
    if (!snapshot) {
      return;
    }

    const inspection = await this.inspectSnapshot(snapshot);
    await this.withSessionLock(sessionId, async () => {
      const current = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (!current || !isDeepStrictEqual(current, snapshot)) {
        return;
      }
      await this.applyInspection(current, inspection.runtime, inspection.ready);
      const resultingSession = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (
        !resultingSession ||
        !isDeepStrictEqual(resultingSession, snapshot)
      ) {
        await this.persist();
      }
    });
  }

  private async inspectSnapshot(
    snapshot: StoredSession,
  ): Promise<{ runtime: RuntimeInspection; ready?: boolean }> {
    const runtime = await this.runtime.inspect(snapshot);
    if (
      runtime.kind !== "alive" ||
      snapshot.stopRequestedAt ||
      !snapshot.definition.readyUrl
    ) {
      return { runtime };
    }
    return {
      runtime,
      ready: await this.probeUrl(snapshot.definition.readyUrl),
    };
  }

  private async applyInspection(
    session: StoredSession,
    inspection: RuntimeInspection,
    readyResult?: boolean,
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
      ? readyResult ?? await this.probeUrl(session.definition.readyUrl)
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
      const replacement = this.addSession(
        session.entryId,
        session.entryName,
        session.location,
        session.definition,
      );
      await this.withSessionLock(replacement.id, async () => {
        await this.startRuntime(replacement);
      });
    }
  }

  private addSession(
    entryId: string,
    entryName: string,
    location: EntryLocation,
    definition: ProcessSessionDefinition,
  ): StoredSession {
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
    return session;
  }

  private async startRuntime(session: StoredSession): Promise<void> {
    try {
      await this.runtime.start(session);
    } catch (error) {
      session.status = "failed";
      session.openPending = false;
      session.message = `Could not start the Session runner: ${errorMessage(error)}`;
      await this.persist();
    }
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

  private async withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionQueues.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === current) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateQueue;
    let release!: () => void;
    this.stateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    const previous = this.persistenceQueue;
    let release!: () => void;
    this.persistenceQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.store.save(structuredClone(this.sessions));
    } finally {
      release();
    }
  }

  private schedulePoll(): void {
    if (
      this.closed ||
      this.pollIntervalMs <= 0 ||
      this.pollTimer
    ) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.reconcileNow()
        .catch((error: unknown) => {
          this.warn(`Could not reconcile Sessions: ${errorMessage(error)}`);
        })
        .finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
    this.pollTimer.unref();
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
