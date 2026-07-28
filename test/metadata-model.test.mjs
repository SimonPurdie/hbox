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
  mergeVisiblePinOrder,
  matchesEntry,
  tagIconFor,
} from "../dist/public/assets/model.js";

const fallback = {
  name: "Folder Name",
  tags: [],
  defaultAction: null,
  hasCustomIcon: false,
};

test("metadata normalizes tags and accepts only known defaults", () => {
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
      hasCustomIcon: false,
    },
  );

  assert.deepEqual(
    parseMetadata('{"defaultAction":"run"}', fallback),
    fallback,
  );
  assert.deepEqual(parseMetadata("{", fallback), fallback);
});

test("tag icon selection uses canonical priority rather than entry order", () => {
  const base = {
    id: "entry",
    name: "Entry",
    defaultAction: null,
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
