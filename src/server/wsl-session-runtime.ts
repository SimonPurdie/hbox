import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredSession } from "./session-store.js";
import type {
  RuntimeInspection,
  SessionRuntime,
} from "./session-runtime.js";

const SESSION_LAUNCHER_PATH = fileURLToPath(
  new URL("./session-launcher.vbs", import.meta.url),
);

const scriptCache = new Map<string, Promise<string>>();

export class WslSessionRuntime implements SessionRuntime {
  async start(session: StoredSession): Promise<void> {
    if (session.location.kind !== "wsl") {
      throw new Error("The WSL runtime received a Windows Session.");
    }
    await launchHiddenWindowsProcess("wsl.exe", [
      "--distribution",
      session.location.distribution,
      "--cd",
      session.location.path,
      "--exec",
      "/bin/sh",
      "-c",
      await readWslScript("run"),
      "hbox-session-runner",
      session.id,
      ...session.definition.command,
    ]);
  }

  async inspect(session: StoredSession): Promise<RuntimeInspection> {
    if (session.location.kind !== "wsl") {
      return {
        kind: "disconnected",
        reason: "The WSL runtime received a Windows Session.",
      };
    }
    let output: string;
    try {
      output = await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        await readWslScript("inspect"),
        "hbox-session-inspect",
        session.id,
      ]);
    } catch (error) {
      return {
        kind: "disconnected",
        reason: `WSL inspection failed: ${errorMessage(error)}`,
      };
    }

    const [kind, detail] = output.trim().split("\t", 2);
    switch (kind) {
      case "pending":
        return { kind: "pending" };
      case "alive": {
        const pid = Number(detail);
        return Number.isSafeInteger(pid) && pid > 0
          ? { kind: "alive", pid }
          : { kind: "disconnected", reason: "Invalid process identity." };
      }
      case "exited": {
        const exitCode = Number(detail);
        return {
          kind: "exited",
          exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
        };
      }
      case "missing":
        return { kind: "missing" };
      case "disconnected":
        return {
          kind: "disconnected",
          reason: inspectionReason(detail),
        };
      default:
        return {
          kind: "disconnected",
          reason: "The Session runner returned an unknown response.",
        };
    }
  }

  async stop(session: StoredSession, force: boolean): Promise<boolean> {
    if (session.location.kind !== "wsl") {
      return false;
    }
    try {
      const stopArguments = force
        ? ["KILL"]
        : session.definition.stopCommand
          ? ["COMMAND", ...session.definition.stopCommand]
          : ["TERM"];
      const output = await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--cd",
        session.location.path,
        "--exec",
        "/bin/sh",
        "-c",
        await readWslScript("stop"),
        "hbox-session-stop",
        session.id,
        ...stopArguments,
      ]);
      return output.trim() === "signalled" ||
        output.trim() === "already_stopped";
    } catch {
      return false;
    }
  }

  async cleanup(session: StoredSession): Promise<void> {
    if (session.location.kind !== "wsl") {
      return;
    }
    try {
      await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        await readWslScript("cleanup"),
        "hbox-session-cleanup",
        session.id,
      ]);
    } catch {
      // Runtime cleanup is best effort after the process is confirmed stopped.
    }
  }
}

async function readWslScript(name: string): Promise<string> {
  let script = scriptCache.get(name);
  if (!script) {
    script = readFile(
      new URL(`./wsl-scripts/${name}.sh`, import.meta.url),
      "utf8",
    );
    scriptCache.set(name, script);
  }
  return await script;
}

async function launchHiddenWindowsProcess(
  command: string,
  args: string[],
): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
  const wscriptPath = path.win32.join(
    systemRoot,
    "System32",
    "wscript.exe",
  );
  const commandPath =
    command.toLocaleLowerCase("en-US") === "wsl.exe"
      ? path.win32.join(systemRoot, "System32", "wsl.exe")
      : command;
  const commandLine = windowsCommandLine(commandPath, args);
  const encodedCommandLine = encodeUtf16Hex(commandLine);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      wscriptPath,
      ["//B", "//NoLogo", SESSION_LAUNCHER_PATH, encodedCommandLine],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `The hidden Session launcher exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

function encodeUtf16Hex(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

export function windowsCommandLine(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) {
    return value;
  }
  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

async function runCaptured(
  command: string,
  args: string[],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, 5_000);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8"));
      } else {
        reject(
          new Error(
            Buffer.concat(errors).toString("utf8").trim() ||
              `${command} exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

function inspectionReason(value: string | undefined): string {
  switch (value) {
    case "wsl_restarted":
      return "The WSL environment restarted.";
    case "identity_mismatch":
      return "The recorded process identity no longer matches.";
    case "token_mismatch":
      return "The process does not contain its HBOX Session token.";
    case "invalid_identity":
      return "The recorded process identity is invalid.";
    default:
      return "HBOX could not verify the process identity.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
