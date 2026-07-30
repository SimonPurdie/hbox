import path from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  computeBuildFingerprint,
  isBuildCurrent,
  replaceBuildOutput,
  resolveCSharpCompiler,
  writeBuildManifest,
} from "./build-lib.mjs";

const buildId = `${process.pid}-${Date.now()}`;
const projectDirectory = path.resolve(".");
const buildDirectory = path.resolve(`.hbox-build-${buildId}`);
const outputDirectory = path.resolve("dist");
const backupDirectory = path.resolve(`.hbox-dist-backup-${buildId}`);
const windowsSessionSources = [
  "windows-session-runner.cs",
  "windows-session-models.cs",
  "windows-session-command.cs",
  "windows-session-storage.cs",
  "windows-session-supervisor.cs",
  "windows-session-native.cs",
].map((name) => path.resolve("src/server", name));
const fingerprint = await computeBuildFingerprint({ projectDirectory });
const force = process.argv.includes("--force");

if (
  !force &&
  await isBuildCurrent({
    outputDirectory,
    fingerprint,
  })
) {
  console.log("HBOX build is current.");
  process.exit(0);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

try {
  await rm(buildDirectory, { recursive: true, force: true });
  await mkdir(path.join(buildDirectory, "public"), { recursive: true });
  await cp("src/public", path.join(buildDirectory, "public"), {
    recursive: true,
  });
  const vendorDirectory = path.join(
    buildDirectory,
    "public",
    "assets",
    "vendor",
  );
  await mkdir(vendorDirectory, { recursive: true });
  await Promise.all([
    cp(
      "node_modules/@melloware/coloris/dist/umd/coloris.min.js",
      path.join(vendorDirectory, "coloris.min.js"),
    ),
    cp(
      "node_modules/@melloware/coloris/dist/coloris.min.css",
      path.join(vendorDirectory, "coloris.min.css"),
    ),
  ]);
  await Promise.all([
    run(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.server.json",
      "--outDir",
      buildDirectory,
    ]),
    run(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.client.json",
      "--outDir",
      path.join(buildDirectory, "public", "assets"),
    ]),
  ]);
  await cp(
    "src/server/session-launcher.vbs",
    path.join(buildDirectory, "server", "session-launcher.vbs"),
  );
  await cp(
    "src/server/wsl-scripts",
    path.join(buildDirectory, "server", "wsl-scripts"),
    { recursive: true },
  );
  await cp(
    "src/server/hbox-contract.md",
    path.join(buildDirectory, "server", "hbox-contract.md"),
  );
  if (process.platform === "win32") {
    const compiler = await resolveCSharpCompiler();
    await Promise.all([
      run(compiler, [
        "/nologo",
        "/target:winexe",
        "/optimize+",
        "/reference:System.Web.Extensions.dll",
        `/out:${path.join(buildDirectory, "server", "protocol-launcher.exe")}`,
        path.resolve("src/server/protocol-launcher.cs"),
      ]),
      run(compiler, [
        "/nologo",
        "/target:winexe",
        "/optimize+",
        "/reference:System.Web.Extensions.dll",
        `/out:${path.join(buildDirectory, "server", "windows-session-runner.exe")}`,
        ...windowsSessionSources,
      ]),
    ]);
  }
  await writeBuildManifest({
    buildDirectory,
    fingerprint,
  });
  await replaceBuildOutput({
    buildDirectory,
    outputDirectory,
    backupDirectory,
  });
} catch (error) {
  await rm(buildDirectory, { recursive: true, force: true });
  throw error;
}
