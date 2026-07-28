import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Registry } from "../dist/server/registry.js";

test("does not overwrite a corrupt registry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(root);
  await writeFile(registry.registryPath, "{ definitely not JSON");

  await assert.rejects(registry.load(), /not valid JSON/);
  assert.equal(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(registry.registryPath, "utf8"),
    ),
    "{ definitely not JSON",
  );
});

test("rejects registry IDs that could escape the icon cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(root);
  await writeFile(
    registry.registryPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "../outside",
          location: { kind: "windows", path: "E:\\Project" },
          lastKnown: {
            name: "Project",
            tags: [],
            defaultAction: null,
            hasCustomIcon: true,
          },
        },
      ],
    }),
  );

  await assert.rejects(registry.load(), /invalid structure/);
});

test("loads old registries and normalizes their pinned Entry IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(root);
  const entryId = "5f1801d8-039e-4d66-8691-b01cbe293fdd";
  const entry = {
    id: entryId,
    location: { kind: "windows", path: "E:\\Project" },
    lastKnown: {
      name: "Project",
      tags: [],
      defaultAction: null,
      hasCustomIcon: false,
    },
  };

  await writeFile(
    registry.registryPath,
    JSON.stringify({ version: 1, entries: [entry] }),
  );
  assert.deepEqual(await registry.load(), {
    version: 1,
    entries: [entry],
    pinnedEntryIds: [],
  });

  await writeFile(
    registry.registryPath,
    JSON.stringify({
      version: 1,
      entries: [entry],
      pinnedEntryIds: [entryId, entryId, "missing"],
    }),
  );
  assert.deepEqual((await registry.load()).pinnedEntryIds, [entryId]);
});
