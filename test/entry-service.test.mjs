import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  assert.deepEqual(await service.getEntryDetails(available[0].id), {
    ...available[0],
    environment: { kind: "windows" },
    location: project,
    metadataStatus: "loaded",
    iconSource: { kind: "custom" },
  });

  const movedProject = `${project}-missing`;
  await rename(project, movedProject);
  const missing = await service.listEntries();
  assert.deepEqual(missing[0], {
    ...available[0],
    available: false,
  });
  assert.equal(
    (await service.getEntryDetails(missing[0].id)).metadataStatus,
    "folder_unavailable",
  );

  await assert.rejects(
    service.performAction(missing[0].id, "folder"),
    EntryUnavailableError,
  );
  assert.equal(launches.length, 0);
  assert.equal(
    (await service.readCachedIcon(missing[0].id)).toString(),
    "<svg></svg>",
  );

  await service.removeEntry(missing[0].id);
  assert.deepEqual(await service.listEntries(), []);
  assert.equal((await stat(movedProject)).isDirectory(), true);
  await assert.rejects(readFile(registry.iconPath(missing[0].id)), {
    code: "ENOENT",
  });
  await assert.rejects(
    service.removeEntry(missing[0].id),
    /Entry not found/,
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

test("reports the canonical built-in icon source in details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-details-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".hbox"), { recursive: true });
  await writeFile(
    path.join(project, ".hbox", "entry.json"),
    JSON.stringify({ tags: ["web", "agent"] }),
  );

  const service = new EntryService(
    new Registry(path.join(root, "app-data")),
    { pick: async () => project },
    { launch: async () => {} },
    () => {},
  );

  const registration = await service.registerFromPicker();
  const details = await service.getEntryDetails(registration.entry.id);
  assert.deepEqual(details.iconSource, { kind: "tag", tag: "agent" });
});
