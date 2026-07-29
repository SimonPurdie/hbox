import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeLaunchBroker,
  NativeLaunchTicketNotFoundError,
  protocolRegistryArguments,
} from "../dist/server/native-launch.js";

const entry = {
  id: "entry-a",
  name: "Project",
  tags: ["script"],
  defaultAction: null,
  actions: [],
  available: true,
  hasCustomIcon: false,
  pinnedPosition: null,
};

test("issues stable opaque launch URIs and resolves their commands", async () => {
  const calls = [];
  const broker = new NativeLaunchBroker(async (entryId, action) => {
    calls.push({ entryId, action });
    return { command: "explorer.exe", args: [String.raw`E:\Project`] };
  });

  const first = broker.addLaunchUris(entry);
  const second = broker.addLaunchUris(entry);
  assert.deepEqual(first.nativeLaunch, second.nativeLaunch);
  assert.match(
    first.nativeLaunch.folder,
    /^hbox-launch:\/\/launch\/[0-9a-f-]{36}$/,
  );
  assert.ok(!first.nativeLaunch.folder.includes(entry.id));

  const ticket = new URL(first.nativeLaunch.folder).pathname.slice(1);
  assert.deepEqual(await broker.resolve(ticket), {
    command: "explorer.exe",
    args: [String.raw`E:\Project`],
  });
  assert.deepEqual(calls, [{ entryId: "entry-a", action: "folder" }]);
  await assert.rejects(
    broker.resolve("00000000-0000-0000-0000-000000000000"),
    NativeLaunchTicketNotFoundError,
  );
});

test("builds a quoted per-user protocol registration", () => {
  const commands = protocolRegistryArguments(
    String.raw`E:\HBOX Folder\protocol-launcher.exe`,
  );

  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0], [
    "add",
    String.raw`HKCU\Software\Classes\hbox-launch`,
    "/ve",
    "/d",
    "URL:HBOX Launch Protocol",
    "/f",
  ]);
  assert.equal(
    commands[2][4],
    '"E:\\HBOX Folder\\protocol-launcher.exe" "%1"',
  );
});

test(
  "builds the Windows protocol launcher as a GUI executable",
  { skip: process.platform !== "win32" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const executable = await readFile(
      new URL("../dist/server/protocol-launcher.exe", import.meta.url),
    );
    const peOffset = executable.readUInt32LE(0x3c);
    const optionalHeader = peOffset + 24;
    const subsystemOffset = optionalHeader + 68;
    assert.equal(executable.readUInt16LE(subsystemOffset), 2);
  },
);
