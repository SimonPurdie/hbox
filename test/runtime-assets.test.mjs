import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const scriptNames = ["run", "inspect", "stop", "cleanup"];

test("build copies each WSL Session script without modification", async () => {
  for (const name of scriptNames) {
    const source = await readFile(
      path.resolve(`src/server/wsl-scripts/${name}.sh`),
      "utf8",
    );
    const built = await readFile(
      path.resolve(`dist/server/wsl-scripts/${name}.sh`),
      "utf8",
    );
    assert.equal(built, source);
  }
});

test(
  "WSL Session scripts pass a direct shell syntax check",
  { skip: process.platform === "win32" },
  async () => {
    for (const name of scriptNames) {
      await run("/bin/sh", [
        "-n",
        path.resolve(`src/server/wsl-scripts/${name}.sh`),
      ]);
    }
  },
);

test("browser build uses focused feature modules", async () => {
  const html = await readFile("dist/public/index.html", "utf8");
  assert.match(html, /assets\/client\/app\.js/);
  for (const name of [
    "api-client",
    "entries-view",
    "entry-details",
    "preferences-view",
    "sessions-view",
  ]) {
    const source = await readFile(
      path.resolve(`dist/public/assets/client/${name}.js`),
      "utf8",
    );
    assert.ok(source.length > 0);
  }
});
