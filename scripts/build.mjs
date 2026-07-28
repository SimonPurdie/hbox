import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

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

await rm("dist", { recursive: true, force: true });
await mkdir("dist/public", { recursive: true });
await Promise.all([
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.server.json",
  ]),
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.client.json",
  ]),
  cp("src/public", "dist/public", { recursive: true }),
]);
