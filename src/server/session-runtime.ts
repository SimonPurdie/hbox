import type { StoredSession } from "./session-store.js";

export type RuntimeInspection =
  | { kind: "pending" }
  | { kind: "alive"; pid: number }
  | { kind: "exited"; exitCode: number | null }
  | { kind: "missing" }
  | { kind: "disconnected"; reason: string };

export interface SessionRuntime {
  start(session: StoredSession): Promise<void>;
  inspect(session: StoredSession): Promise<RuntimeInspection>;
  stop(session: StoredSession, force: boolean): Promise<boolean>;
  cleanup(session: StoredSession): Promise<void>;
}

export class SessionRuntimeRouter implements SessionRuntime {
  constructor(
    private readonly windows: SessionRuntime,
    private readonly wsl: SessionRuntime,
  ) {}

  async start(session: StoredSession): Promise<void> {
    await this.runtimeFor(session).start(session);
  }

  async inspect(session: StoredSession): Promise<RuntimeInspection> {
    return await this.runtimeFor(session).inspect(session);
  }

  async stop(session: StoredSession, force: boolean): Promise<boolean> {
    return await this.runtimeFor(session).stop(session, force);
  }

  async cleanup(session: StoredSession): Promise<void> {
    await this.runtimeFor(session).cleanup(session);
  }

  private runtimeFor(session: StoredSession): SessionRuntime {
    return session.location.kind === "windows" ? this.windows : this.wsl;
  }
}
