import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMetadata,
} from "../dist/server/metadata.js";
import {
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
  };

  assert.equal(tagIconFor({ ...base, tags: ["web", "tool", "agent"] }), "agent");
  assert.equal(tagIconFor({ ...base, tags: ["script", "code"] }), "code");
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
  };

  assert.equal(matchesEntry(entry, "EXEC"), true);
  assert.equal(matchesEntry(entry, "web"), true);
  assert.equal(matchesEntry(entry, "script"), false);
  assert.equal(matchesEntry(entry, ""), true);
});
