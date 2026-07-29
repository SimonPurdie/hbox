import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseMetadata,
  readEntryMetadata,
} from "../dist/server/metadata.js";
import {
  interfaceThemeFor,
  mergeVisiblePinOrder,
  matchesEntry,
  tagIconFor,
} from "../dist/public/assets/model.js";

const fallback = {
  name: "Folder Name",
  tags: [],
  defaultAction: null,
  actions: [],
  hasCustomIcon: false,
};

test("metadata normalizes tags and accepts built-in and declared defaults", () => {
  assert.deepEqual(
    parseMetadata(
      JSON.stringify({
        name: "  My Tool  ",
        tags: [" Web ", "code", "WEB", 42],
        defaultAction: "terminal",
      }),
      fallback,
    ),
    {
      name: "My Tool",
      tags: ["web", "code"],
      defaultAction: "terminal",
      actions: [],
      hasCustomIcon: false,
    },
  );

  assert.deepEqual(
    parseMetadata('{"defaultAction":"run"}', fallback),
    fallback,
  );
  assert.deepEqual(
    parseMetadata(
      JSON.stringify({
        defaultAction: "start-app",
        actions: {
          "start-app": {
            label: "Start app",
            starts: "dev-server",
          },
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
      fallback,
    ),
    {
      name: "Folder Name",
      tags: [],
      defaultAction: "start-app",
      actions: [{ id: "start-app", label: "Start app" }],
      hasCustomIcon: false,
    },
  );
  assert.deepEqual(parseMetadata("{", fallback), fallback);
});

test("tag icon selection uses canonical priority rather than entry order", () => {
  const base = {
    id: "entry",
    name: "Entry",
    defaultAction: null,
    actions: [],
    available: true,
    hasCustomIcon: false,
    pinnedPosition: null,
  };

  assert.equal(
    tagIconFor({ ...base, tags: ["web", "desktop", "agent"] }),
    "agent",
  );
  assert.equal(
    tagIconFor({ ...base, tags: ["script", "data", "gamedev"] }),
    "gamedev",
  );
  assert.equal(
    tagIconFor({ ...base, tags: ["data", "browser-extension"] }),
    "browser-extension",
  );
  assert.equal(tagIconFor({ ...base, tags: ["unknown"] }), null);
  assert.equal(
    tagIconFor({ ...base, tags: ["agent"], hasCustomIcon: true }),
    null,
  );
});

test("search matches case-insensitive name and tag substrings", () => {
  const entry = {
    id: "entry",
    name: "Omni Executor",
    tags: ["Agent", "web-app"],
    defaultAction: null,
    actions: [],
    available: false,
    hasCustomIcon: false,
    pinnedPosition: null,
  };

  assert.equal(matchesEntry(entry, "EXEC"), true);
  assert.equal(matchesEntry(entry, "web"), true);
  assert.equal(matchesEntry(entry, "script"), false);
  assert.equal(matchesEntry(entry, ""), true);
});

test("merges filtered pin reordering without moving hidden pins", () => {
  assert.deepEqual(
    mergeVisiblePinOrder(
      ["hidden-a", "visible-a", "hidden-b", "visible-b"],
      ["visible-b", "visible-a"],
    ),
    ["hidden-a", "visible-b", "hidden-b", "visible-a"],
  );
  assert.throws(
    () => mergeVisiblePinOrder(["a", "b"], ["a", "missing"]),
    /does not match/,
  );
});

test("interface theme selects the higher-contrast foreground", () => {
  assert.deepEqual(interfaceThemeFor("#193b56"), {
    foreground: "#ffffff",
    iconFilter: "none",
    shadowColor: "rgb(7 20 32 / 65%)",
    colorScheme: "dark",
  });
  assert.deepEqual(interfaceThemeFor("#f0dca0"), {
    foreground: "#17202b",
    iconFilter: "invert(1)",
    shadowColor: "rgb(255 255 255 / 60%)",
    colorScheme: "light",
  });
  assert.throws(() => interfaceThemeFor("navy"), /invalid/);
});

test("reports loaded, missing, and invalid metadata states", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = { kind: "windows", path: root };
  const warnings = [];

  assert.equal(
    (await readEntryMetadata(location, (message) => warnings.push(message)))
      .metadataStatus,
    "not_found",
  );

  await mkdir(path.join(root, ".hbox"));
  await writeFile(path.join(root, ".hbox", "entry.json"), "{");
  assert.equal(
    (await readEntryMetadata(location, (message) => warnings.push(message)))
      .metadataStatus,
    "invalid",
  );

  await writeFile(path.join(root, ".hbox", "entry.json"), '{"tags":["web"]}');
  assert.equal(
    (await readEntryMetadata(location, (message) => warnings.push(message)))
      .metadataStatus,
    "loaded",
  );
  assert.equal(warnings.length, 1);
});

test("loads validated action and process Session definitions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".hbox"));
  await writeFile(
    path.join(root, ".hbox", "entry.json"),
    JSON.stringify({
      actions: {
        "start-app": { label: "Start app", starts: "dev-server" },
        broken: { label: "Broken", starts: "missing" },
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

  const metadata = await readEntryMetadata({
    kind: "windows",
    path: root,
  });
  assert.deepEqual(metadata.actionDefinitions, [
    {
      id: "start-app",
      label: "Start app",
      starts: "dev-server",
    },
  ]);
  assert.deepEqual(metadata.sessionDefinitions, [
    {
      id: "dev-server",
      type: "process",
      label: "Development server",
      command: ["npm", "run", "dev"],
      stopCommand: ["npm", "run", "stop"],
      readyUrl: "http://127.0.0.1:5173/",
      openUrl: "http://127.0.0.1:5173/",
      singleInstance: true,
    },
  ]);
});
