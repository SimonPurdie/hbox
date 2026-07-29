import assert from "node:assert/strict";
import test from "node:test";
import { createLauncher } from "../scripts/windows-startup.mjs";

test("creates a hidden startup launcher with quoted Windows paths", () => {
  const launcher = createLauncher({
    nodePath: String.raw`E:\Node JS\node.exe`,
    entryScript: String.raw`E:\My Projects\hbox\dist\server\index.js`,
    projectDirectory: String.raw`E:\My Projects\hbox`,
  });

  assert.match(launcher, /nodePath = "E:\\Node JS\\node\.exe"/);
  assert.match(
    launcher,
    /entryScript = "E:\\My Projects\\hbox\\dist\\server\\index\.js"/,
  );
  assert.match(
    launcher,
    /shell\.CurrentDirectory = "E:\\My Projects\\hbox"/,
  );
  assert.match(launcher, /shell\.Run .+, 0, False/);
});

test("escapes quotes in generated VBScript strings", () => {
  const launcher = createLauncher({
    nodePath: String.raw`E:\A "quoted" folder\node.exe`,
    entryScript: String.raw`E:\hbox\dist\server\index.js`,
    projectDirectory: String.raw`E:\hbox`,
  });

  assert.match(
    launcher,
    /nodePath = "E:\\A ""quoted"" folder\\node\.exe"/,
  );
});
