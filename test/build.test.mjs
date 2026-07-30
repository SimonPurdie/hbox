import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_MANIFEST,
  computeBuildFingerprint,
  isBuildCurrent,
  replaceBuildOutput,
  requiredBuildOutputs,
  resolveCSharpCompiler,
  writeBuildManifest,
} from "../scripts/build-lib.mjs";

test("build fingerprint changes with inputs and target platform", async (t) => {
  const root = await createProjectFixture(t);
  const options = {
    projectDirectory: root,
    platform: "linux",
    architecture: "x64",
    nodeVersion: "v25.0.0",
  };
  const original = await computeBuildFingerprint(options);
  await writeFile(path.join(root, "src", "app.ts"), "export const app = 2;\n");
  const changed = await computeBuildFingerprint(options);
  const otherPlatform = await computeBuildFingerprint({
    ...options,
    platform: "darwin",
  });

  assert.notEqual(changed, original);
  assert.notEqual(otherPlatform, changed);
});

test("build freshness requires every recorded and platform output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-build-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "dist");
  await createOutputs(output, "linux");
  await writeBuildManifest({
    buildDirectory: output,
    fingerprint: "current",
    platform: "linux",
    architecture: "x64",
  });

  assert.equal(
    await isBuildCurrent({
      outputDirectory: output,
      fingerprint: "current",
      platform: "linux",
      architecture: "x64",
    }),
    true,
  );

  await rm(path.join(output, "server", "index.js"));
  assert.equal(
    await isBuildCurrent({
      outputDirectory: output,
      fingerprint: "current",
      platform: "linux",
      architecture: "x64",
    }),
    false,
  );
  assert.equal(
    await isBuildCurrent({
      outputDirectory: output,
      fingerprint: "current",
      platform: "win32",
      architecture: "x64",
    }),
    false,
  );
});

test("a failed output swap preserves the previous fingerprint", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-build-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "dist");
  const staged = path.join(root, "staged");
  const backup = path.join(root, "backup");
  await createOutputs(output, "linux");
  await writeBuildManifest({
    buildDirectory: output,
    fingerprint: "previous",
    platform: "linux",
    architecture: "x64",
  });
  await createOutputs(staged, "linux");
  await writeBuildManifest({
    buildDirectory: staged,
    fingerprint: "replacement",
    platform: "linux",
    architecture: "x64",
  });
  await rm(staged, { recursive: true, force: true });

  await assert.rejects(
    replaceBuildOutput({
      buildDirectory: staged,
      outputDirectory: output,
      backupDirectory: backup,
    }),
  );
  const manifest = JSON.parse(
    await readFile(path.join(output, BUILD_MANIFEST), "utf8"),
  );
  assert.equal(manifest.fingerprint, "previous");
});

test("missing C# compiler reports the checked framework locations", async () => {
  await assert.rejects(
    resolveCSharpCompiler({ WINDIR: String.raw`Z:\MissingWindows` }),
    /Expected csc\.exe at .*Framework64.* or .*Framework/i,
  );
});

async function createProjectFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hbox-fingerprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(path.join(root, "scripts", "build.mjs"), "export {};\n");
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.client.json",
    "tsconfig.server.json",
  ]) {
    await writeFile(path.join(root, file), "{}\n");
  }
  for (const [packageName, version] of [
    ["typescript", "5.9.0"],
    ["@melloware/coloris", "0.25.0"],
    ["saxes", "6.0.0"],
  ]) {
    const directory = path.join(
      root,
      "node_modules",
      ...packageName.split("/"),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ version }),
    );
  }
  return root;
}

async function createOutputs(directory, platform) {
  for (const relativePath of requiredBuildOutputs(platform)) {
    const destination = path.join(directory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${relativePath}\n`);
  }
}
