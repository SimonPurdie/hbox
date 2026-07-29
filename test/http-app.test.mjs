import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EntryUnavailableError,
  InvalidPinOrderError,
} from "../dist/server/entry-service.js";
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

test("protects and schedules the restart endpoint", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  let restartCount = 0;
  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async () => {},
    readCachedIcon: async () => Buffer.from(""),
  };
  const server = createHttpServer(
    service,
    staticDirectory,
    () => {},
    () => {
      restartCount += 1;
    },
    "test-instance",
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const blocked = await fetch(`${baseUrl}/api/restart`, { method: "POST" });
  assert.equal(blocked.status, 403);

  const accepted = await fetch(`${baseUrl}/api/restart`, {
    method: "POST",
    headers: { Origin: baseUrl },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { instanceId: "test-instance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restartCount, 1);

  const status = await fetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { instanceId: "test-instance" });
});

test("serves Entry details and protects removal by origin", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  const removed = [];
  const details = {
    id: "abc",
    name: "Example",
    tags: ["tool"],
    defaultAction: null,
    available: false,
    hasCustomIcon: false,
    pinnedPosition: null,
    environment: { kind: "wsl", distribution: "Ubuntu" },
    location: "/home/simon/example",
    metadataStatus: "folder_unavailable",
    iconSource: { kind: "fallback" },
  };
  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async () => {},
    getEntryDetails: async () => details,
    removeEntry: async (id) => removed.push(id),
    readCachedIcon: async () => Buffer.from(""),
  };
  const server = createHttpServer(service, staticDirectory, () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const detailResponse = await fetch(`${baseUrl}/api/entries/abc`);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(await detailResponse.json(), details);

  const blocked = await fetch(`${baseUrl}/api/entries/abc`, {
    method: "DELETE",
  });
  assert.equal(blocked.status, 403);

  const removedResponse = await fetch(`${baseUrl}/api/entries/abc`, {
    method: "DELETE",
    headers: { Origin: baseUrl },
  });
  assert.equal(removedResponse.status, 204);
  assert.deepEqual(removed, ["abc"]);
});

test("protects pin mutations and accepts an explicit pin order", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  const calls = [];
  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async () => {},
    pinEntry: async (id) => calls.push({ operation: "pin", id }),
    unpinEntry: async (id) => calls.push({ operation: "unpin", id }),
    reorderPinnedEntries: async (entryIds) => {
      if (entryIds.includes("invalid")) {
        throw new InvalidPinOrderError();
      }
      calls.push({ operation: "reorder", entryIds });
    },
    readCachedIcon: async () => Buffer.from(""),
  };
  const server = createHttpServer(service, staticDirectory, () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.equal(
    (await fetch(`${baseUrl}/api/entries/abc/pin`, { method: "POST" }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/pins/order`, {
        method: "PUT",
        body: JSON.stringify({ entryIds: ["a"] }),
      })
    ).status,
    403,
  );

  const headers = {
    Origin: baseUrl,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(`${baseUrl}/api/entries/abc/pin`, {
        method: "POST",
        headers,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/entries/abc/pin`, {
        method: "DELETE",
        headers,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/pins/order`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ entryIds: ["b", "a"] }),
      })
    ).status,
    204,
  );
  assert.deepEqual(calls, [
    { operation: "pin", id: "abc" },
    { operation: "unpin", id: "abc" },
    { operation: "reorder", entryIds: ["b", "a"] },
  ]);

  assert.equal(
    (
      await fetch(`${baseUrl}/api/pins/order`, {
        method: "PUT",
        headers,
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/pins/order`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ entryIds: ["invalid"] }),
      })
    ).status,
    400,
  );
});

test("serves and controls Sessions through protected endpoints", async (t) => {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), "hbox-http-"));
  t.after(() => rm(staticDirectory, { recursive: true, force: true }));

  const calls = [];
  const listed = [{ id: "session-a", status: "running" }];
  const sessions = {
    listSessions: async () => listed,
    openSession: async (id) => calls.push({ action: "open", id }),
    stopSession: async (id) => calls.push({ action: "stop", id }),
    restartSession: async (id) => calls.push({ action: "restart", id }),
    recheckSession: async (id) => calls.push({ action: "recheck", id }),
    forgetSession: async (id) => calls.push({ action: "forget", id }),
  };
  const service = {
    listEntries: async () => [],
    registerFromPicker: async () => null,
    performAction: async () => {},
    readCachedIcon: async () => Buffer.from(""),
  };
  const server = createHttpServer(
    service,
    staticDirectory,
    () => {},
    undefined,
    "test-instance",
    sessions,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(
    await fetch(`${baseUrl}/api/sessions`).then((response) =>
      response.json(),
    ),
    listed,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/sessions/session-a/stop`, {
        method: "POST",
      })
    ).status,
    403,
  );

  const headers = { Origin: baseUrl };
  for (const action of ["open", "stop", "restart", "recheck"]) {
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/sessions/session-a/${action}`,
          { method: "POST", headers },
        )
      ).status,
      202,
    );
  }
  assert.equal(
    (
      await fetch(`${baseUrl}/api/sessions/session-a`, {
        method: "DELETE",
        headers,
      })
    ).status,
    204,
  );
  assert.deepEqual(calls, [
    { action: "open", id: "session-a" },
    { action: "stop", id: "session-a" },
    { action: "restart", id: "session-a" },
    { action: "recheck", id: "session-a" },
    { action: "forget", id: "session-a" },
  ]);
});
