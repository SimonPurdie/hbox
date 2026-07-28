import assert from "node:assert/strict";
import test from "node:test";
import {
  inferredName,
  locationAccessPath,
  locationKey,
  parseSelectedPath,
} from "../dist/server/paths.js";
import { actionCommand } from "../dist/server/launcher.js";

test("normalizes WSL UNC aliases into a canonical location", () => {
  const localhost = parseSelectedPath(
    String.raw`\\wsl.localhost\Ubuntu\home\simon\project`,
  );
  const legacy = parseSelectedPath(
    String.raw`\\wsl$\ubuntu\home\simon\project`,
  );

  assert.deepEqual(localhost, {
    kind: "wsl",
    distribution: "Ubuntu",
    path: "/home/simon/project",
  });
  assert.equal(locationKey(localhost), locationKey(legacy));
  assert.equal(
    locationAccessPath(localhost),
    String.raw`\\wsl.localhost\Ubuntu\home\simon\project`,
  );
  assert.equal(inferredName(localhost), "project");
});

test("normalizes and de-duplicates Windows paths case-insensitively", () => {
  const first = parseSelectedPath(String.raw`E:\Projects\HBOX\\`);
  const second = parseSelectedPath(String.raw`e:\projects\hbox`);

  assert.deepEqual(first, {
    kind: "windows",
    path: String.raw`E:\Projects\HBOX`,
  });
  assert.equal(locationKey(first), locationKey(second));
  assert.equal(inferredName(first), "HBOX");
});

test("rejects relative selected paths", () => {
  assert.throws(() => parseSelectedPath("projects\\hbox"), /absolute path/);
});

test("constructs Explorer and terminal launches without shell strings", () => {
  const windowsLocation = {
    kind: "windows",
    path: String.raw`E:\A folder & more`,
  };
  const wslLocation = {
    kind: "wsl",
    distribution: "Ubuntu",
    path: "/home/simon/a folder",
  };

  assert.deepEqual(actionCommand("folder", windowsLocation), {
    command: "explorer.exe",
    args: [String.raw`E:\A folder & more`],
  });
  assert.deepEqual(actionCommand("terminal", windowsLocation), {
    command: "wt.exe",
    args: ["-d", String.raw`E:\A folder & more`],
  });
  assert.deepEqual(actionCommand("terminal", wslLocation), {
    command: "wt.exe",
    args: [
      "new-tab",
      "wsl.exe",
      "--distribution",
      "Ubuntu",
      "--cd",
      "/home/simon/a folder",
    ],
  });
});
