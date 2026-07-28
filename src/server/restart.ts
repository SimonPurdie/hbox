import { spawn } from "node:child_process";
import type { Server } from "node:http";

export async function replaceCurrentProcess(server: Server): Promise<void> {
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
