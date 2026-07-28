import { spawn } from "node:child_process";
import type { Server } from "node:http";
import path from "node:path";

export async function rebuildAndReplaceCurrentProcess(
  server: Server,
): Promise<void> {
  await rebuildProject();

  const entryScript = process.argv[1];
  if (!entryScript) {
    throw new Error("The HBOX entry script is unavailable.");
  }

  await closeServer(server);

  const replacement = spawn(process.execPath, [entryScript], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.once("spawn", resolve);
  });
  replacement.unref();
}

export async function rebuildProject(): Promise<void> {
  const buildScript = path.resolve(process.cwd(), "scripts", "build.mjs");
  const build = spawn(process.execPath, [buildScript], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    build.once("error", reject);
    build.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`The HBOX build exited with code ${code ?? "unknown"}.`),
        );
      }
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
