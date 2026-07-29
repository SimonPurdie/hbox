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
  InvalidPinOrderError,
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
  await writeFile(
    path.join(metadataDirectory, "icon.svg"),
    '<svg viewBox="0 0 24 24"><path fill="#123" d="M2 2h20v20H2z"/></svg>',
  );

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
  assert.equal(registration?.entry.pinnedPosition, null);

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
  const cachedIcon = (await service.readCachedIcon(missing[0].id)).toString();
  assert.match(cachedIcon, /width="24" height="24"/);
  assert.match(cachedIcon, /fill="#cf8f00"/);
  assert.doesNotMatch(cachedIcon, /#123/);

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

test("starts a declared process Session through a custom Entry action", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".hbox"), { recursive: true });
  await writeFile(
    path.join(project, ".hbox", "entry.json"),
    JSON.stringify({
      name: "Web Project",
      defaultAction: "start-app",
      actions: {
        "start-app": { label: "Start app", starts: "dev-server" },
      },
      sessions: {
        "dev-server": {
          type: "process",
          label: "Development server",
          command: ["npm", "run", "dev"],
          readyUrl: "http://127.0.0.1:5173",
          openUrl: "http://127.0.0.1:5173",
        },
      },
    }),
  );

  const starts = [];
  const service = new EntryService(
    new Registry(path.join(root, "app-data")),
    { pick: async () => project },
    { launch: async () => {}, openUrl: async () => {} },
    () => {},
    {
      startSession: async (entry, definition) => {
        starts.push({ entry, definition });
      },
    },
  );

  const registration = await service.registerFromPicker();
  assert.equal(registration.entry.defaultAction, "start-app");
  assert.deepEqual(registration.entry.actions, [
    { id: "start-app", label: "Start app" },
  ]);

  await service.performAction(registration.entry.id, "start-app");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].entry.id, registration.entry.id);
  assert.deepEqual(starts[0].definition.command, ["npm", "run", "dev"]);
  await assert.rejects(
    service.performAction(registration.entry.id, "missing-action"),
    /action not found/i,
  );
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

  await writeFile(
    path.join(project, ".hbox", "entry.json"),
    JSON.stringify({ tags: ["unknown"] }),
  );
  assert.deepEqual(
    (await service.getEntryDetails(registration.entry.id)).iconSource,
    { kind: "fallback" },
  );
});

test("caches normalized icons and remembers invalid source signatures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-icon-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const metadataDirectory = path.join(project, ".hbox");
  const iconPath = path.join(metadataDirectory, "icon.svg");
  await mkdir(metadataDirectory, { recursive: true });
  await writeFile(
    path.join(metadataDirectory, "entry.json"),
    JSON.stringify({ tags: ["tool"] }),
  );
  await writeFile(
    iconPath,
    '<svg viewBox="0 0 48 24"><path stroke="red" fill="none" d="M1 1h46"/></svg>',
  );

  const warnings = [];
  const registry = new Registry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => project },
    { launch: async () => {} },
    (message) => warnings.push(message),
  );

  const registration = await service.registerFromPicker();
  assert.equal(registration.entry.hasCustomIcon, true);
  const entryId = registration.entry.id;
  assert.match(
    (await service.readCachedIcon(entryId)).toString(),
    /viewBox="0 0 48 24".*stroke="#cf8f00"/,
  );

  const cacheRecordPath = registry.iconCacheRecordPath(entryId);
  const firstRecordTime = (await stat(cacheRecordPath)).mtimeMs;
  await service.listEntries();
  assert.equal((await stat(cacheRecordPath)).mtimeMs, firstRecordTime);

  await writeFile(
    iconPath,
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
  );
  const invalid = await service.listEntries();
  assert.equal(invalid[0].hasCustomIcon, false);
  assert.deepEqual(
    (await service.getEntryDetails(entryId)).iconSource,
    { kind: "fallback" },
  );
  await assert.rejects(service.readCachedIcon(entryId), /Entry not found/);
  assert.equal(warnings.length, 1);

  await service.listEntries();
  assert.equal(warnings.length, 1);
  assert.equal(
    JSON.parse(await readFile(cacheRecordPath, "utf8")).status,
    "invalid",
  );
});

test("pins unavailable Entries, preserves pin order, and cleans removals", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = ["Alpha", "Bravo", "Charlie"].map((name) =>
    path.join(root, name),
  );
  for (const project of projects) {
    await mkdir(project);
  }

  let pickerIndex = 0;
  const registry = new Registry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => projects[pickerIndex++] },
    { launch: async () => {} },
    () => {},
  );
  const registrations = [];
  for (const project of projects) {
    registrations.push(await service.registerFromPicker());
  }
  const [alpha, bravo, charlie] = registrations.map(
    (registration) => registration.entry,
  );

  await service.pinEntry(bravo.id);
  await service.pinEntry(alpha.id);
  await rename(projects[2], `${projects[2]}-missing`);
  await service.pinEntry(charlie.id);

  let listed = await service.listEntries();
  assert.deepEqual(
    listed.map(({ name, available, pinnedPosition }) => ({
      name,
      available,
      pinnedPosition,
    })),
    [
      { name: "Alpha", available: true, pinnedPosition: 1 },
      { name: "Bravo", available: true, pinnedPosition: 0 },
      { name: "Charlie", available: false, pinnedPosition: 2 },
    ],
  );

  await service.reorderPinnedEntries([charlie.id, bravo.id, alpha.id]);
  await service.unpinEntry(bravo.id);
  await service.pinEntry(bravo.id);
  assert.deepEqual((await registry.load()).pinnedEntryIds, [
    charlie.id,
    alpha.id,
    bravo.id,
  ]);
  await assert.rejects(
    service.reorderPinnedEntries([charlie.id, alpha.id]),
    InvalidPinOrderError,
  );
  await assert.rejects(
    service.pinEntry("00000000-0000-4000-8000-000000000000"),
    /Entry not found/,
  );

  await service.removeEntry(alpha.id);
  assert.deepEqual((await registry.load()).pinnedEntryIds, [
    charlie.id,
    bravo.id,
  ]);
});
