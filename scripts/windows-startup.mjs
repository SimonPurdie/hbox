import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, rm, writeFile } from "node:fs/promises";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entryScript = path.join(projectDirectory, "dist", "server", "index.js");

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await run(process.argv[2]);
}

async function run(action) {
  if (process.platform !== "win32") {
    throw new Error(
      "Windows startup registration must be run with Windows Node.js.",
    );
  }

  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is unavailable for the current Windows user.");
  }

  const startupDirectory = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const launcherPath = path.join(startupDirectory, "HBOX.vbs");

  switch (action) {
    case "install":
      await install(startupDirectory, launcherPath);
      break;
    case "uninstall":
      await uninstall(launcherPath);
      break;
    default:
      throw new Error(
        "Expected an action: node scripts/windows-startup.mjs install|uninstall",
      );
  }
}

async function install(startupDirectory, launcherPath) {
  await access(entryScript);
  await mkdir(startupDirectory, { recursive: true });
  await writeFile(
    launcherPath,
    createLauncher({
      nodePath: process.execPath,
      entryScript,
      projectDirectory,
    }),
    "utf8",
  );
  console.log(`HBOX will start at login for ${process.env.USERNAME ?? "you"}.`);
  console.log(`Startup launcher: ${launcherPath}`);
}

async function uninstall(launcherPath) {
  await rm(launcherPath, { force: true });
  console.log(`Removed the HBOX startup launcher: ${launcherPath}`);
}

export function createLauncher({ nodePath, entryScript, projectDirectory }) {
  return [
    "Option Explicit",
    "Dim shell, nodePath, entryScript",
    `nodePath = ${vbsString(nodePath)}`,
    `entryScript = ${vbsString(entryScript)}`,
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(projectDirectory)}`,
    'shell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & entryScript & Chr(34), 0, False',
    "Set shell = Nothing",
    "",
  ].join("\r\n");
}

function vbsString(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
