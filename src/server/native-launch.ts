import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LaunchCommand } from "./launcher.js";
import type {
  BuiltInActionName,
  ClientEntry,
} from "./types.js";

const PROTOCOL = "hbox-launch";
const PROTOCOL_KEY = `HKCU\\Software\\Classes\\${PROTOCOL}`;

export class NativeLaunchTicketNotFoundError extends Error {
  constructor() {
    super("Native launch ticket not found.");
  }
}

export class NativeLaunchBroker {
  private readonly tickets = new Map<
    string,
    { entryId: string; action: BuiltInActionName }
  >();
  private readonly actionTickets = new Map<string, string>();

  constructor(
    private readonly resolveLaunch: (
      entryId: string,
      action: BuiltInActionName,
    ) => Promise<LaunchCommand>,
  ) {}

  addLaunchUris(entry: ClientEntry): ClientEntry {
    return {
      ...entry,
      nativeLaunch: {
        folder: this.issue(entry.id, "folder"),
        terminal: this.issue(entry.id, "terminal"),
      },
    };
  }

  async resolve(ticket: string): Promise<LaunchCommand> {
    const launch = this.tickets.get(ticket);
    if (!launch) {
      throw new NativeLaunchTicketNotFoundError();
    }
    return await this.resolveLaunch(launch.entryId, launch.action);
  }

  private issue(entryId: string, action: BuiltInActionName): string {
    const actionKey = `${entryId}\0${action}`;
    let ticket = this.actionTickets.get(actionKey);
    if (!ticket) {
      ticket = randomUUID();
      this.actionTickets.set(actionKey, ticket);
      this.tickets.set(ticket, { entryId, action });
    }
    return `${PROTOCOL}://launch/${ticket}`;
  }
}

export async function registerNativeLaunchProtocol(
  launcherScript: string,
  warn: (message: string) => void = console.warn,
): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const pwshPath = path.win32.join(
    process.env.ProgramFiles ?? String.raw`C:\Program Files`,
    "PowerShell",
    "7",
    "pwsh.exe",
  );
  try {
    await access(pwshPath);
    await access(launcherScript);
    for (const args of protocolRegistryArguments(pwshPath, launcherScript)) {
      await runRegistryCommand(args);
    }
    return true;
  } catch (error) {
    warn(
      `Could not register the HBOX launch protocol: ${errorMessage(error)}`,
    );
    return false;
  }
}

export function protocolRegistryArguments(
  pwshPath: string,
  launcherScript: string,
): string[][] {
  const command = [
    quoteWindowsArgument(pwshPath),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteWindowsArgument(launcherScript),
    '"%1"',
  ].join(" ");

  return [
    ["add", PROTOCOL_KEY, "/ve", "/d", "URL:HBOX Launch Protocol", "/f"],
    ["add", PROTOCOL_KEY, "/v", "URL Protocol", "/d", "", "/f"],
    [
      "add",
      `${PROTOCOL_KEY}\\shell\\open\\command`,
      "/ve",
      "/d",
      command,
      "/f",
    ],
  ];
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function runRegistryCommand(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("reg.exe", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`reg.exe exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
