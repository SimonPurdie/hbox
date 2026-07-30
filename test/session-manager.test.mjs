import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  stopCommand: null,
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
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

test("removes a Session that exits successfully without a stop request", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const store = new SessionStore(root);
  const manager = new SessionManager(
    store,
    runtime,
    { openUrl: async () => {} },
    { pollIntervalMs: 0, probeUrl: async () => true },
  );
  await manager.initialize();

  const started = await manager.startSession(entry, definition);
  runtime.inspections.set(started.id, { kind: "exited", exitCode: 0 });
  await manager.reconcileNow();

  assert.deepEqual(await manager.listSessions(), []);
  assert.deepEqual(runtime.cleanups, [started.id]);
  assert.deepEqual(await store.load(), []);
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

test("accepts a Windows Entry through the shared Session lifecycle", async (t) => {
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

  const started = await manager.startSession(
    {
      ...entry,
      location: { kind: "windows", path: String.raw`E:\Project` },
    },
    definition,
  );
  assert.equal(started.status, "starting");
  assert.deepEqual(runtime.starts, [started.id]);
});

test("does not queue automatic reconciliation while a probe is slow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const probe = deferred();
  let probeCalls = 0;
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async () => {} },
    {
      pollIntervalMs: 5,
      probeUrl: async () => {
        probeCalls += 1;
        return await probe.promise;
      },
    },
  );
  t.after(() => manager.close());
  await manager.initialize();
  const started = await manager.startSession(entry, definition);
  runtime.inspections.set(started.id, { kind: "alive", pid: 123 });

  await waitFor(
    () => probeCalls === 1,
    "The automatic readiness probe did not start.",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(probeCalls, 1);

  manager.close();
  probe.resolve(true);
  await manager.reconcileNow();
  assert.equal((await manager.listSessions())[0].status, "running");
});

test("a slow Session does not delay an action on another Session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slowInspection = deferred();
  const slowInspectionStarted = deferred();
  const stopped = deferred();
  let slowSessionId;
  const runtime = {
    async start() {},
    async inspect(session) {
      if (session.id === slowSessionId) {
        slowInspectionStarted.resolve();
        return await slowInspection.promise;
      }
      return { kind: "alive", pid: 456 };
    },
    async stop(session, force) {
      stopped.resolve({ id: session.id, force });
      return true;
    },
    async cleanup() {},
  };
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async () => {} },
    {
      pollIntervalMs: 0,
      reconcileConcurrency: 1,
      probeUrl: async () => true,
    },
  );
  await manager.initialize();
  const first = await manager.startSession(
    entry,
    { ...definition, singleInstance: false },
  );
  slowSessionId = first.id;
  const second = await manager.startSession(
    {
      ...entry,
      id: "9d65c13b-32db-46c5-a537-6196bc36a8b4",
      lastKnown: { ...entry.lastKnown, name: "Other Project" },
    },
    { ...definition, singleInstance: false },
  );

  const reconciliation = manager.reconcileNow();
  await slowInspectionStarted.promise;
  const stop = manager.stopSession(second.id);
  const stopResult = await Promise.race([
    stopped.promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("The unrelated stop action was delayed.")),
        250,
      ),
    ),
  ]);
  assert.deepEqual(stopResult, { id: second.id, force: false });
  await stop;

  slowInspection.resolve({ kind: "alive", pid: 123 });
  await reconciliation;
  assert.equal(
    (await manager.listSessions()).find(({ id }) => id === second.id).status,
    "stopping",
  );
});

test("a stale inspection cannot overwrite a newer Session action", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staleInspection = deferred();
  const inspectionStarted = deferred();
  let inspectionCalls = 0;
  const runtime = {
    async start() {},
    async inspect() {
      inspectionCalls += 1;
      if (inspectionCalls === 1) {
        inspectionStarted.resolve();
        return await staleInspection.promise;
      }
      return { kind: "alive", pid: 456 };
    },
    async stop() {
      return true;
    },
    async cleanup() {},
  };
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async () => {} },
    { pollIntervalMs: 0, probeUrl: async () => true },
  );
  await manager.initialize();
  const started = await manager.startSession(entry, definition);

  const reconciliation = manager.reconcileNow();
  await inspectionStarted.promise;
  await manager.stopSession(started.id);
  staleInspection.resolve({ kind: "alive", pid: 123 });
  await reconciliation;

  const [session] = await manager.listSessions();
  assert.equal(session.status, "stopping");
  assert.equal(inspectionCalls, 2);
});

test("reconciles Sessions with bounded concurrency and persists every result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let activeInspections = 0;
  let maximumInspections = 0;
  const runtime = {
    async start() {},
    async inspect() {
      activeInspections += 1;
      maximumInspections = Math.max(maximumInspections, activeInspections);
      await new Promise((resolve) => setImmediate(resolve));
      activeInspections -= 1;
      return { kind: "alive", pid: 123 };
    },
    async stop() {
      return true;
    },
    async cleanup() {},
  };
  const manager = new SessionManager(
    new SessionStore(root),
    runtime,
    { openUrl: async () => {} },
    {
      pollIntervalMs: 0,
      reconcileConcurrency: 3,
      probeUrl: async () => true,
    },
  );
  await manager.initialize();
  for (let index = 0; index < 7; index += 1) {
    await manager.startSession(
      {
        ...entry,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      },
      { ...definition, singleInstance: false },
    );
  }

  await manager.reconcileNow();

  assert.equal(maximumInspections, 3);
  assert.deepEqual(
    (await manager.listSessions()).map(({ status }) => status),
    Array(7).fill("running"),
  );
  assert.deepEqual(
    (await new SessionStore(root).load()).map(({ status }) => status),
    Array(7).fill("running"),
  );
});

test("migrates version 1 WSL Session records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stopCommand: _stopCommand, ...legacyDefinition } = definition;
  await writeFile(
    path.join(root, "sessions.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: "88e1ff42-e6da-4b7c-a7f5-28583a25c7e0",
          entryId: entry.id,
          entryName: entry.lastKnown.name,
          definitionId: definition.id,
          definition: legacyDefinition,
          location: entry.location,
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          readyAt: "2026-01-01T00:00:01.000Z",
          message: null,
          openPending: false,
          stopRequestedAt: null,
          restartPending: false,
        },
      ],
    }),
  );

  const [migrated] = await new SessionStore(root).load();
  assert.equal(migrated.definition.stopCommand, null);
  assert.equal(migrated.location.kind, "wsl");
});
