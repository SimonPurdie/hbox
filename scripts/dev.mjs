import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("HBOX dev mode must run with Windows Node.js.");
}

const projectDirectory = path.resolve(".");
const buildScript = path.join(projectDirectory, "scripts", "build.mjs");
const entryScript = path.join(
  projectDirectory,
  "dist",
  "server",
  "index.js",
);
const watchers = [];
let server = null;
let rebuilding = false;
let rebuildPending = false;
let closing = false;

await buildIfNeeded();
startServer();

for (const directory of ["src", "scripts"]) {
  watchers.push(
    watch(
      path.join(projectDirectory, directory),
      { recursive: true },
      scheduleRebuild,
    ),
  );
}
for (const file of [
  "package.json",
  "package-lock.json",
  "tsconfig.client.json",
  "tsconfig.server.json",
]) {
  watchers.push(
    watch(path.join(projectDirectory, file), scheduleRebuild),
  );
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

function scheduleRebuild() {
  rebuildPending = true;
  if (!rebuilding) {
    void rebuildAndRestart();
  }
}

async function rebuildAndRestart() {
  rebuilding = true;
  try {
    while (rebuildPending && !closing) {
      await delay(100);
      rebuildPending = false;
      try {
        await buildIfNeeded();
        await stopServer();
        startServer();
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    rebuilding = false;
  }
}

async function buildIfNeeded() {
  await run(process.execPath, [buildScript]);
}

function startServer() {
  server = spawn(process.execPath, [entryScript], {
    cwd: projectDirectory,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  server.once("exit", (code, signal) => {
    if (!closing && server) {
      console.error(
        `HBOX server stopped (${signal ?? code ?? "unknown"}).`,
      );
    }
    server = null;
  });
}

async function stopServer() {
  const current = server;
  if (!current) {
    return;
  }
  server = null;
  if (current.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    current.once("exit", resolve);
    current.kill();
  });
}

async function close() {
  if (closing) {
    return;
  }
  closing = true;
  for (const watcher of watchers) {
    watcher.close();
  }
  await stopServer();
  process.exit(0);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDirectory,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${path.basename(command)} exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
