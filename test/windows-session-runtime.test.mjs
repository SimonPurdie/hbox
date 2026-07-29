import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsSessionRuntime } from "../dist/server/windows-session-runtime.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 30_000 };

test(
  "reconnects to a Windows process tree and uses its stop command",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hbox-windows-session-"));
    const dataDirectory = path.join(root, "data");
    const markerPath = path.join(root, "stop.marker");
    const childPidPath = path.join(root, "child.pid");
    const workerPath = path.join(root, "worker.cjs");
    await writeFile(
      workerPath,
      [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        `const marker = ${JSON.stringify(markerPath)};`,
        `const childPid = ${JSON.stringify(childPidPath)};`,
        "const child = spawn(process.execPath,",
        '  ["-e", "setInterval(() => {}, 1000)"],',
        '  { stdio: "ignore" });',
        "fs.writeFileSync(childPid, String(child.pid));",
        'process.stdout.write(`ready ${process.cwd()}\\\\n`);',
        'process.stderr.write("warning\\\\n");',
        "const timer = setInterval(() => {",
        "  if (fs.existsSync(marker)) {",
        "    clearInterval(timer);",
        "    child.kill();",
        "    process.exit(0);",
        "  }",
        "}, 25);",
      ].join("\n"),
    );

    const runtime = new WindowsSessionRuntime(dataDirectory);
    const session = windowsSession(
      "ad502c5b-b8e8-47c1-babc-c7c046eb8888",
      root,
      [process.execPath, workerPath],
      [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "stop"); console.log("stop requested")`,
      ],
    );
    t.after(async () => {
      await runtime.stop(session, true);
      await runtime.cleanup(session);
      await rm(root, { recursive: true, force: true });
    });

    await runtime.start(session);
    assert.equal((await waitFor(runtime, session, "alive")).kind, "alive");

    const replacement = new WindowsSessionRuntime(dataDirectory);
    assert.equal((await replacement.inspect(session)).kind, "alive");
    const output = await readFile(
      path.join(
        dataDirectory,
        "windows-sessions",
        session.id,
        "output.log",
      ),
      "utf8",
    );
    assert.match(output, /ready/);
    assert.ok(
      output.toLocaleLowerCase().includes(root.toLocaleLowerCase()),
    );
    assert.match(output, /warning/);

    assert.equal(await replacement.stop(session, false), true);
    const exited = await waitFor(replacement, session, "exited");
    assert.equal(exited.exitCode, 0);
    assert.match(
      await readFile(
        path.join(
          dataDirectory,
          "windows-sessions",
          session.id,
          "stop-output.log",
        ),
        "utf8",
      ),
      /stop requested/,
    );

    const childPid = Number(await readFile(childPidPath, "utf8"));
    await waitForProcessExit(childPid);
    await replacement.cleanup(session);
  },
);

test(
  "rejects altered Windows identity and force-stops the verified Job",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hbox-windows-session-"));
    const dataDirectory = path.join(root, "data");
    const runtime = new WindowsSessionRuntime(dataDirectory);
    const session = windowsSession(
      "577332b6-7cc0-4fd2-a8ef-bf2028861440",
      root,
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      null,
    );
    t.after(async () => {
      await runtime.stop(session, true);
      await runtime.cleanup(session);
      await rm(root, { recursive: true, force: true });
    });

    await runtime.start(session);
    await waitFor(runtime, session, "alive");
    const identityPath = path.join(
      dataDirectory,
      "windows-sessions",
      session.id,
      "identity.json",
    );
    const identityText = await readFile(identityPath, "utf8");
    const identity = JSON.parse(identityText);
    identity.rootStarted += 1;
    await writeFile(identityPath, JSON.stringify(identity));

    assert.equal((await runtime.inspect(session)).kind, "disconnected");
    assert.equal(await runtime.stop(session, true), false);

    await writeFile(identityPath, identityText);
    assert.equal(await runtime.stop(session, true), true);
    assert.equal((await waitFor(runtime, session, "exited")).kind, "exited");
  },
);

test(
  "uses Ctrl+Break when a Windows Session has no stop command",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hbox-windows-session-"));
    const dataDirectory = path.join(root, "data");
    const markerPath = path.join(root, "break.marker");
    const workerPath = path.join(root, "break-worker.cjs");
    await writeFile(
      workerPath,
      [
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(markerPath)};`,
        'process.on("SIGBREAK", () => {',
        '  fs.writeFileSync(marker, "break");',
        "  process.exit(0);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const runtime = new WindowsSessionRuntime(dataDirectory);
    const session = windowsSession(
      "90767bb2-22a2-433f-bdce-b3b6663c7065",
      root,
      [process.execPath, workerPath],
      null,
    );
    t.after(async () => {
      await runtime.stop(session, true);
      await runtime.cleanup(session);
      await rm(root, { recursive: true, force: true });
    });

    await runtime.start(session);
    await waitFor(runtime, session, "alive");
    assert.equal(await runtime.stop(session, false), true);
    const exited = await waitFor(runtime, session, "exited");
    assert.equal(exited.exitCode, 0);
    assert.equal(await readFile(markerPath, "utf8"), "break");
  },
);

test(
  "resolves npm.cmd through Windows PATHEXT",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hbox-windows-session-"));
    const dataDirectory = path.join(root, "data");
    const runtime = new WindowsSessionRuntime(dataDirectory);
    const session = windowsSession(
      "b12e87d7-5a83-4eec-93f1-52c13c11adf8",
      root,
      ["npm", "--version"],
      null,
    );
    t.after(async () => {
      await runtime.cleanup(session);
      await rm(root, { recursive: true, force: true });
    });

    await runtime.start(session);
    const exited = await waitFor(runtime, session, "exited");
    assert.equal(exited.exitCode, 0);
    assert.match(
      await readFile(
        path.join(
          dataDirectory,
          "windows-sessions",
          session.id,
          "output.log",
        ),
        "utf8",
      ),
      /\d+\.\d+\.\d+/,
    );
  },
);

test(
  "records Windows command launch failures as exits",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hbox-windows-session-"));
    const dataDirectory = path.join(root, "data");
    const runtime = new WindowsSessionRuntime(dataDirectory);
    const session = windowsSession(
      "709ab1c5-7099-4ed2-92c5-953a31ca4dbd",
      root,
      ["hbox-command-that-does-not-exist"],
      null,
    );
    t.after(async () => {
      await runtime.cleanup(session);
      await rm(root, { recursive: true, force: true });
    });

    await runtime.start(session);
    const exited = await waitFor(runtime, session, "exited");
    assert.equal(exited.exitCode, 70);
  },
);

function windowsSession(id, cwd, command, stopCommand) {
  return {
    id,
    entryId: "entry",
    entryName: "Windows project",
    definitionId: "dev",
    definition: {
      id: "dev",
      type: "process",
      label: "Development server",
      command,
      stopCommand,
      readyUrl: null,
      openUrl: null,
      singleInstance: true,
    },
    location: { kind: "windows", path: cwd },
    status: "starting",
    startedAt: new Date().toISOString(),
    readyAt: null,
    message: null,
    openPending: false,
    stopRequestedAt: null,
    restartPending: false,
  };
}

async function waitFor(runtime, session, expectedKind) {
  const deadline = Date.now() + 10_000;
  let inspection;
  while (Date.now() < deadline) {
    inspection = await runtime.inspect(session);
    if (inspection.kind === expectedKind) {
      return inspection;
    }
    if (inspection.kind === "disconnected") {
      assert.fail(inspection.reason);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Timed out waiting for ${expectedKind}; last state was ${inspection?.kind}.`,
  );
}

async function waitForProcessExit(processId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Child process ${processId} remained alive.`);
}
