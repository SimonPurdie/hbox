import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EntryService,
  EntryUnavailableError,
} from "../dist/server/entry-service.js";
import { Registry } from "../dist/server/registry.js";

test("keeps a missing Entry visible from its last-known cache and rejects actions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const project = path.join(root, "project");
  const metadataDirectory = path.join(project, ".hbox");
  await mkdir(metadataDirectory, { recursive: true });
  await writeFile(
    path.join(metadataDirectory, "entry.json"),
    JSON.stringify({
      name: "Cached Project",
      tags: ["web", "agent"],
      defaultAction: "folder",
    }),
  );
  await writeFile(path.join(metadataDirectory, "icon.svg"), "<svg></svg>");

  const registry = new Registry(path.join(root, "app-data"));
  const launches = [];
  const picker = { pick: async () => project };
  const launcher = {
    launch: async (action, location) => launches.push({ action, location }),
  };
  const service = new EntryService(registry, picker, launcher, () => {});

  const registration = await service.registerFromPicker();
  assert.equal(registration?.created, true);
  assert.equal(registration?.entry.name, "Cached Project");
  assert.equal(registration?.entry.hasCustomIcon, true);

  const available = await service.listEntries();
  assert.equal(available.length, 1);
  assert.equal(available[0].available, true);

  await rename(project, `${project}-missing`);
  const missing = await service.listEntries();
  assert.deepEqual(missing[0], {
    ...available[0],
    available: false,
  });

  await assert.rejects(
    service.performAction(missing[0].id, "folder"),
    EntryUnavailableError,
  );
  assert.equal(launches.length, 0);
  assert.equal(
    (await service.readCachedIcon(missing[0].id)).toString(),
    "<svg></svg>",
  );
});

test("returns the existing Entry when the picker selects a duplicate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);

  const service = new EntryService(
    new Registry(path.join(root, "app-data")),
    { pick: async () => project },
    { launch: async () => {} },
    () => {},
  );

  const first = await service.registerFromPicker();
  const second = await service.registerFromPicker();
  assert.equal(first?.created, true);
  assert.equal(second?.created, false);
  assert.equal(first?.entry.id, second?.entry.id);
  assert.equal((await service.listEntries()).length, 1);
});
