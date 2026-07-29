import path from "node:path";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const buildId = `${process.pid}-${Date.now()}`;
const buildDirectory = path.resolve(`.hbox-build-${buildId}`);
const outputDirectory = path.resolve("dist");
const backupDirectory = path.resolve(`.hbox-dist-backup-${buildId}`);

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
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
  await Promise.all([
    run(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.server.json",
      "--outDir",
      path.join(buildDirectory, "server"),
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
  await replaceOutput();
} catch (error) {
  await rm(buildDirectory, { recursive: true, force: true });
  throw error;
}

async function replaceOutput() {
  let hasBackup = false;
  try {
    await rm(backupDirectory, { recursive: true, force: true });
    try {
      await rename(outputDirectory, backupDirectory);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await rename(buildDirectory, outputDirectory);
  } catch (error) {
    if (hasBackup) {
      await rename(backupDirectory, outputDirectory);
    }
    throw error;
  }

  if (hasBackup) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}
