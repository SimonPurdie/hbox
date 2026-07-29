import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_INTERFACE_COLOR,
  InvalidPreferencesError,
  PreferencesStore,
} from "../dist/server/preferences.js";

test("preferences use the default interface colour until saved", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hbox-preferences-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PreferencesStore(directory);

  assert.deepEqual(await store.load(), {
    interfaceColor: DEFAULT_INTERFACE_COLOR,
  });
  assert.deepEqual(
    await store.save({ interfaceColor: "#A0B1C2" }),
    { interfaceColor: "#a0b1c2" },
  );
  assert.deepEqual(await store.load(), { interfaceColor: "#a0b1c2" });
});

test("preferences reject invalid colours and malformed files", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hbox-preferences-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PreferencesStore(directory);

  await assert.rejects(
    store.save({ interfaceColor: "blue" }),
    InvalidPreferencesError,
  );
  await writeFile(store.preferencesPath, "{", "utf8");
  await assert.rejects(store.load(), /not valid JSON/);
});
