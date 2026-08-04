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
  InvalidEntryPathError,
  InvalidPinOrderError,
  SelectedFolderUnavailableError,
} from "../dist/server/entry-service.js";
import { Registry } from "../dist/server/registry.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class BlockingIconRegistry extends Registry {
  blockIconReads = false;
  iconReadStarted = deferred();
  releaseIconRead = deferred();

  async readIconCacheRecord(entryId) {
    if (this.blockIconReads) {
      this.iconReadStarted.resolve();
      await this.releaseIconRead.promise;
    }
    return await super.readIconCacheRecord(entryId);
  }
}

class MeasuringIconRegistry extends Registry {
  measureIconReads = false;
  activeIconReads = 0;
  maximumIconReads = 0;
  totalIconReads = 0;
  expectedActive = 0;
  limitReached = deferred();
  releaseIconReads = deferred();

  async readIconCacheRecord(entryId) {
    if (this.measureIconReads) {
      this.activeIconReads += 1;
      this.totalIconReads += 1;
      this.maximumIconReads = Math.max(
        this.maximumIconReads,
        this.activeIconReads,
      );
      if (this.activeIconReads === this.expectedActive) {
        this.limitReached.resolve();
      }
      await this.releaseIconReads.promise;
      this.activeIconReads -= 1;
    }
    return await super.readIconCacheRecord(entryId);
  }
}

class CacheRemovalRegistry extends Registry {
  cacheRemovals = 0;

  async removeCachedIcon(entryId) {
    this.cacheRemovals += 1;
    await super.removeCachedIcon(entryId);
  }
}

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

test("overlapping registrations create one Entry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-registration-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  const registry = new Registry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
  );

  const registrations = await Promise.all([
    service.registerLocation(project),
    service.registerLocation(project),
  ]);

  assert.deepEqual(
    registrations.map(({ created }) => created).sort(),
    [false, true],
  );
  assert.equal(registrations[0].entry.id, registrations[1].entry.id);
  assert.equal((await registry.read()).entries.length, 1);
});

test("metadata refresh cannot undo an overlapping pin", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-refresh-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const metadataDirectory = path.join(project, ".hbox");
  await mkdir(metadataDirectory, { recursive: true });
  await writeFile(
    path.join(metadataDirectory, "entry.json"),
    JSON.stringify({ name: "Before refresh" }),
  );
  await writeFile(
    path.join(metadataDirectory, "icon.svg"),
    '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>',
  );
  const registry = new BlockingIconRegistry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
  );
  const registration = await service.registerLocation(project);
  await writeFile(
    path.join(metadataDirectory, "entry.json"),
    JSON.stringify({ name: "After refresh" }),
  );
  registry.blockIconReads = true;

  const refresh = service.listEntries();
  await registry.iconReadStarted.promise;
  await service.pinEntry(registration.entry.id);
  registry.releaseIconRead.resolve();
  await refresh;

  const data = await registry.read();
  assert.deepEqual(data.pinnedEntryIds, [registration.entry.id]);
  assert.equal(data.entries[0].lastKnown.name, "After refresh");
});

test("bounds concurrent Entry refresh and completes every Entry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-refresh-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new MeasuringIconRegistry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
    undefined,
    { refreshConcurrency: 3 },
  );
  for (let index = 0; index < 10; index += 1) {
    const project = path.join(root, `Project ${index}`);
    await mkdir(path.join(project, ".hbox"), { recursive: true });
    await writeFile(
      path.join(project, ".hbox", "icon.svg"),
      '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>',
    );
    await service.registerLocation(project);
  }
  registry.expectedActive = 3;
  registry.measureIconReads = true;

  const listing = service.listEntries();
  await registry.limitReached.promise;
  assert.equal(registry.maximumIconReads, 3);
  assert.equal(registry.totalIconReads, 3);
  registry.releaseIconReads.resolve();

  assert.equal((await listing).length, 10);
  assert.equal(registry.maximumIconReads, 3);
  assert.equal(registry.totalIconReads, 10);
});

test("does not remove an absent icon cache during routine refresh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-cache-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  const registry = new CacheRemovalRegistry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
  );
  const registration = await service.registerLocation(project);

  await service.listEntries();
  await service.getEntryDetails(registration.entry.id);
  assert.equal(registry.cacheRemovals, 0);

  await service.removeEntry(registration.entry.id);
  assert.equal(registry.cacheRemovals, 1);
});

test("registration, pin reorder, and removal preserve every overlapping change", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-entry-races-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = ["Alpha", "Bravo", "Charlie", "Remove", "New"].map(
    (name) => path.join(root, name),
  );
  await Promise.all(projects.map((project) => mkdir(project)));
  const registry = new Registry(path.join(root, "app-data"));
  const service = new EntryService(
    registry,
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
  );
  const existing = [];
  for (const project of projects.slice(0, 4)) {
    existing.push((await service.registerLocation(project)).entry);
  }
  for (const entry of existing.slice(0, 3)) {
    await service.pinEntry(entry.id);
  }

  const [registered] = await Promise.all([
    service.registerLocation(projects[4]),
    service.reorderPinnedEntries([
      existing[2].id,
      existing[1].id,
      existing[0].id,
    ]),
    service.removeEntry(existing[3].id),
  ]);

  const data = await registry.read();
  assert.equal(registered.created, true);
  assert.deepEqual(data.pinnedEntryIds, [
    existing[2].id,
    existing[1].id,
    existing[0].id,
  ]);
  assert.equal(
    data.entries.some(({ id }) => id === existing[3].id),
    false,
  );
  assert.equal(
    data.entries.some(({ id }) => id === registered.entry.id),
    true,
  );
});

test("inspects and registers an explicit project path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-explicit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".hbox"), { recursive: true });
  await writeFile(
    path.join(project, ".hbox", "entry.json"),
    '{"name":"Explicit Project","tags":["script"]}',
  );

  const service = new EntryService(
    new Registry(path.join(root, "app-data")),
    { pick: async () => null },
    { launch: async () => {} },
    () => {},
  );
  assert.equal((await service.inspectLocation(project)).valid, true);

  const first = await service.registerLocation(project);
  const second = await service.registerLocation(project);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.entry.id, second.entry.id);

  await assert.rejects(
    service.registerLocation("relative"),
    InvalidEntryPathError,
  );
  await assert.rejects(
    service.registerLocation(path.join(root, "missing")),
    SelectedFolderUnavailableError,
  );
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

test("starts and independently tracks multiple Sessions from one action", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".hbox"), { recursive: true });
  await writeFile(
    path.join(project, ".hbox", "entry.json"),
    JSON.stringify({
      actions: {
        "start-stack": {
          label: "Start stack",
          starts: ["dev-server", "asset-watcher"],
        },
      },
      sessions: {
        "dev-server": {
          type: "process",
          label: "Development server",
          command: ["npm", "run", "dev"],
        },
        "asset-watcher": {
          type: "process",
          label: "Asset watcher",
          command: ["npm", "run", "watch-assets"],
        },
      },
    }),
  );

  const starts = [];
  const releaseFirstStart = deferred();
  const secondStartBegan = deferred();
  t.after(() => releaseFirstStart.resolve());
  const service = new EntryService(
    new Registry(path.join(root, "app-data")),
    { pick: async () => project },
    { launch: async () => {}, openUrl: async () => {} },
    () => {},
    {
      startSession: async (entry, definition) => {
        starts.push({ entryId: entry.id, definitionId: definition.id });
        if (definition.id === "dev-server") {
          await releaseFirstStart.promise;
        } else {
          secondStartBegan.resolve();
        }
      },
    },
  );
  const registration = await service.registerFromPicker();

  const action = service.performAction(registration.entry.id, "start-stack");
  let timeout;
  try {
    await Promise.race([
      secondStartBegan.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The second Session start was delayed.")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  releaseFirstStart.resolve();
  await action;

  assert.deepEqual(starts, [
    { entryId: registration.entry.id, definitionId: "dev-server" },
    { entryId: registration.entry.id, definitionId: "asset-watcher" },
  ]);
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
  assert.deepEqual((await registry.read()).pinnedEntryIds, [
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
  assert.deepEqual((await registry.read()).pinnedEntryIds, [
    charlie.id,
    bravo.id,
  ]);
});
