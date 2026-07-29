import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuntimeRouter } from "../dist/server/session-runtime.js";

class RecordingRuntime {
  calls = [];

  async start(session) {
    this.calls.push(["start", session.id]);
  }

  async inspect(session) {
    this.calls.push(["inspect", session.id]);
    return { kind: "alive", pid: 123 };
  }

  async stop(session, force) {
    this.calls.push(["stop", session.id, force]);
    return true;
  }

  async cleanup(session) {
    this.calls.push(["cleanup", session.id]);
  }
}

test("routes every Session operation by Entry environment", async () => {
  const windows = new RecordingRuntime();
  const wsl = new RecordingRuntime();
  const router = new SessionRuntimeRouter(windows, wsl);
  const windowsSession = {
    id: "windows",
    location: { kind: "windows", path: String.raw`E:\Project` },
  };
  const wslSession = {
    id: "wsl",
    location: {
      kind: "wsl",
      distribution: "Ubuntu",
      path: "/home/simon/project",
    },
  };

  await router.start(windowsSession);
  await router.inspect(wslSession);
  await router.stop(windowsSession, true);
  await router.cleanup(wslSession);

  assert.deepEqual(windows.calls, [
    ["start", "windows"],
    ["stop", "windows", true],
  ]);
  assert.deepEqual(wsl.calls, [
    ["inspect", "wsl"],
    ["cleanup", "wsl"],
  ]);
});
