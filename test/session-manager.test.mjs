import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../dist/server/session-manager.js";
import { SessionStore } from "../dist/server/session-store.js";

const definition = {
  id: "dev-server",
  type: "process",
  label: "Development server",
  command: ["npm", "run", "dev"],
  readyUrl: "http://127.0.0.1:5173/",
  openUrl: "http://127.0.0.1:5173/",
  singleInstance: true,
};

const entry = {
  id: "5f1801d8-039e-4d66-8691-b01cbe293fdd",
  location: {
    kind: "wsl",
    distribution: "Ubuntu",
    path: "/home/simon/project",
  },
  lastKnown: {
    name: "Web Project",
    tags: ["web"],
    defaultAction: "start-app",
    actions: [{ id: "start-app", label: "Start app" }],
    hasCustomIcon: false,
  },
};

class FakeRuntime {
  inspections = new Map();
  starts = [];
  stops = [];
  cleanups = [];

  async start(session) {
    this.starts.push(session.id);
    this.inspections.set(session.id, { kind: "pending" });
  }

  async inspect(session) {
    return this.inspections.get(session.id) ?? { kind: "pending" };
  }

  async stop(session, force) {
    this.stops.push({ id: session.id, force });
    return true;
  }

  async cleanup(session) {
    this.cleanups.push(session.id);
  }
}

test("starts, reconciles, persists, and cleanly stops a WSL Session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const opened = [];
  const options = {
    pollIntervalMs: 0,
    probeUrl: async () => true,
  };
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async (url) => opened.push(url) },
    options,
  );
  await manager.initialize();

  const started = await manager.startSession(entry, definition);
  assert.equal(started.status, "starting");
  assert.deepEqual(runtime.starts, [started.id]);

  runtime.inspections.set(started.id, { kind: "alive", pid: 123 });
  await manager.reconcileNow();
  assert.deepEqual(opened, ["http://127.0.0.1:5173/"]);
  assert.deepEqual(
    (await manager.listSessions()).map(
      ({ status, canOpen, canStop, canRestart }) => ({
        status,
        canOpen,
        canStop,
        canRestart,
      }),
    ),
    [
      {
        status: "running",
        canOpen: true,
        canStop: true,
        canRestart: true,
      },
    ],
  );

  const replacement = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async (url) => opened.push(url) },
    options,
  );
  await replacement.initialize();
  assert.equal((await replacement.listSessions())[0].status, "running");
  assert.equal(opened.length, 1);

  await replacement.stopSession(started.id);
  assert.equal((await replacement.listSessions())[0].status, "stopping");
  assert.deepEqual(runtime.stops, [{ id: started.id, force: false }]);
  runtime.inspections.set(started.id, { kind: "exited", exitCode: 143 });
  await replacement.reconcileNow();
  assert.deepEqual(await replacement.listSessions(), []);
  assert.deepEqual(runtime.cleanups, [started.id]);
});

test("retains failures and disables destructive actions when identity is uncertain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async () => {} },
    { pollIntervalMs: 0, probeUrl: async () => true },
  );
  await manager.initialize();

  const started = await manager.startSession(entry, definition);
  runtime.inspections.set(started.id, {
    kind: "disconnected",
    reason: "The WSL environment restarted.",
  });
  await manager.reconcileNow();

  const [disconnected] = await manager.listSessions();
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.canStop, false);
  assert.equal(disconnected.canRestart, false);
  assert.equal(disconnected.canForget, true);
  assert.equal(disconnected.canRecheck, true);
  await assert.rejects(
    manager.stopSession(started.id),
    /cannot be stopped/i,
  );

  runtime.inspections.set(started.id, { kind: "alive", pid: 321 });
  await manager.recheckSession(started.id);
  assert.equal((await manager.listSessions())[0].status, "running");

  runtime.inspections.set(started.id, { kind: "exited", exitCode: 1 });
  await manager.reconcileNow();
  const [failed] = await manager.listSessions();
  assert.equal(failed.status, "failed");
  assert.equal(failed.canRestart, true);
  assert.equal(failed.canForget, true);
  assert.match(failed.message, /code 1/);
});

test("reuses a running single-instance Session instead of starting a duplicate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const opened = [];
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async (url) => opened.push(url) },
    { pollIntervalMs: 0, probeUrl: async () => true },
  );
  await manager.initialize();

  const first = await manager.startSession(entry, definition);
  runtime.inspections.set(first.id, { kind: "alive", pid: 123 });
  await manager.reconcileNow();
  await manager.startSession(entry, definition);

  assert.equal(runtime.starts.length, 1);
  assert.equal((await manager.listSessions()).length, 1);
  assert.deepEqual(opened, [
    "http://127.0.0.1:5173/",
    "http://127.0.0.1:5173/",
  ]);
});
