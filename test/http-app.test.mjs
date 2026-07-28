import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EntryUnavailableError } from "../dist/server/entry-service.js";
import { createHttpServer } from "../dist/server/http-app.js";

test("serves Entries and protects mutation endpoints by origin", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  await writeFile(path.join(staticDirectory, "index.html"), "<p>HBOX</p>");
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  const calls = [];
  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async (id, action) => calls.push({ id, action }),
    readCachedIcon: async () => {
      throw new Error("not used");
    },
  };
  const server = createHttpServer(service, staticDirectory, () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listResponse = await fetch(`${baseUrl}/api/entries`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), []);

  const blocked = await fetch(`${baseUrl}/api/entries/abc/actions/folder`, {
    method: "POST",
  });
  assert.equal(blocked.status, 403);

  const accepted = await fetch(`${baseUrl}/api/entries/abc/actions/folder`, {
    method: "POST",
    headers: { Origin: baseUrl },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [{ id: "abc", action: "folder" }]);
});

test("maps unavailable action attempts to a stable conflict response", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async (id) => {
      throw new EntryUnavailableError(id);
    },
    readCachedIcon: async () => Buffer.from(""),
  };
  const server = createHttpServer(service, staticDirectory, () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(
    `${baseUrl}/api/entries/missing/actions/terminal`,
    { method: "POST", headers: { Origin: baseUrl } },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "entry_unavailable" });
});
