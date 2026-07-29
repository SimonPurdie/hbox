import { spawn } from "node:child_process";
import { locationAccessPath } from "./paths.js";
import type { BuiltInActionName, EntryLocation } from "./types.js";

export interface ActionLauncher {
  launch(action: BuiltInActionName, location: EntryLocation): Promise<void>;
  openUrl(url: string): Promise<void>;
}

export class WindowsActionLauncher implements ActionLauncher {
  async launch(
    action: BuiltInActionName,
    location: EntryLocation,
  ): Promise<void> {
    const launch = actionCommand(action, location);
    await launchDetached(launch.command, launch.args);
  }

  async openUrl(url: string): Promise<void> {
    await launchDetached("explorer.exe", [url]);
  }
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

export function actionCommand(
  action: BuiltInActionName,
  location: EntryLocation,
): LaunchCommand {
  if (action === "folder") {
    return {
      command: "explorer.exe",
      args: [locationAccessPath(location)],
    };
  }

  if (location.kind === "windows") {
    return {
      command: "wt.exe",
      args: ["-d", location.path],
    };
  }

  return {
    command: "wt.exe",
    args: [
      "new-tab",
      "wsl.exe",
      "--distribution",
      location.distribution,
      "--cd",
      location.path,
    ],
  };
}

async function launchDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
