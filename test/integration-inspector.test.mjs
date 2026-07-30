import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectIntegration } from "../dist/server/integration-inspector.js";

test("inspects effective metadata and validates a custom icon", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".hbox"));
  await writeFile(
    path.join(root, ".hbox", "entry.json"),
    JSON.stringify({
      name: "Web App",
      tags: ["Web", "Agent"],
      defaultAction: "start-app",
      actions: {
        "start-app": { label: "Start app", starts: "dev-server" },
      },
      sessions: {
        "dev-server": {
          type: "process",
          label: "Development server",
          command: ["npm", "run", "dev"],
          stopCommand: ["npm", "run", "stop"],
          readyUrl: "http://127.0.0.1:5173",
          openUrl: "http://127.0.0.1:5173",
        },
      },
    }),
  );
  await writeFile(
    path.join(root, ".hbox", "icon.svg"),
    '<svg viewBox="0 0 24 24"><path fill="red" d="M2 2h20v20H2z"/></svg>',
  );

  const result = await inspectIntegration({
    kind: "windows",
    path: root,
  });
  assert.equal(result.valid, true);
  assert.equal(result.metadataStatus, "loaded");
  assert.deepEqual(result.issues, []);
  assert.equal(result.effective.name, "Web App");
  assert.deepEqual(result.effective.tags, ["web", "agent"]);
  assert.equal(result.effective.defaultAction, "start-app");
  assert.deepEqual(result.effective.actions, [
    {
      id: "start-app",
      label: "Start app",
      starts: "dev-server",
    },
  ]);
  assert.equal(result.effective.sessions[0].singleInstance, true);
  assert.deepEqual(result.effective.sessions[0].stopCommand, [
    "npm",
    "run",
    "stop",
  ]);
  assert.equal(result.icon.status, "valid");
});

test("reports declarations that HBOX omits and an invalid icon", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".hbox"));
  await writeFile(
    path.join(root, ".hbox", "entry.json"),
    JSON.stringify({
      defaultAction: "start-app",
      actions: {
        "start-app": { label: "Start app", starts: "missing" },
      },
      sessions: {
        broken: {
          type: "process",
          label: "Broken",
          command: "npm run dev",
        },
      },
    }),
  );
  await writeFile(
    path.join(root, ".hbox", "icon.svg"),
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
  );

  const result = await inspectIntegration({
    kind: "windows",
    path: root,
  });
  assert.equal(result.valid, false);
  assert.equal(result.icon.status, "invalid");
  assert.deepEqual(result.effective.actions, []);
  assert.deepEqual(result.effective.sessions, []);
  assert.ok(result.issues.includes(
    "sessions.broken.command must be a non-empty array of non-empty strings.",
  ));
  assert.ok(result.issues.includes(
    "actions.start-app.starts must reference an accepted Session ID.",
  ));
  assert.ok(result.issues.includes(
    'defaultAction must be "folder", "terminal", or an accepted custom action ID.',
  ));
  assert.ok(result.issues.some((issue) => issue.includes("custom SVG")));
});

test("requires project-owned metadata but not a custom icon", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const missing = await inspectIntegration({
    kind: "windows",
    path: root,
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.metadataStatus, "not_found");

  await mkdir(path.join(root, ".hbox"));
  await writeFile(
    path.join(root, ".hbox", "entry.json"),
    '{"tags":["script"]}',
  );
  const valid = await inspectIntegration({
    kind: "windows",
    path: root,
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.icon, { status: "absent" });
});
