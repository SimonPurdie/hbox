import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredSession } from "./session-store.js";
import type {
  RuntimeInspection,
  SessionRuntime,
} from "./session-runtime.js";

const RUNNER_SOURCE_PATH = fileURLToPath(
  new URL("./windows-session-runner.exe", import.meta.url),
);

interface WindowsRunnerConfig {
  token: string;
  cwd: string;
  command: string[];
  stopCommand: string[] | null;
}

export class WindowsSessionRuntime implements SessionRuntime {
  private readonly stateRoot: string;

  constructor(
    dataDirectory: string,
    private readonly runnerSourcePath: string = RUNNER_SOURCE_PATH,
  ) {
    this.stateRoot = path.join(dataDirectory, "windows-sessions");
  }

  async start(session: StoredSession): Promise<void> {
    if (session.location.kind !== "windows") {
      throw new Error("The Windows runtime received a WSL Session.");
    }

    const stateDirectory = this.stateDirectory(session.id);
    const runnerPath = this.runnerPath(session.id);
    await mkdir(stateDirectory, { recursive: true });
    await copyFile(this.runnerSourcePath, runnerPath);
    await writeJsonAtomically(
      path.join(stateDirectory, "config.json"),
      {
        token: randomBytes(32).toString("hex"),
        cwd: session.location.path,
        command: [...session.definition.command],
        stopCommand: session.definition.stopCommand
          ? [...session.definition.stopCommand]
          : null,
      } satisfies WindowsRunnerConfig,
    );

    const child = spawn(
      runnerPath,
      ["supervise", path.join(stateDirectory, "config.json")],
      {
        cwd: stateDirectory,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  }

  async inspect(session: StoredSession): Promise<RuntimeInspection> {
    if (session.location.kind !== "windows") {
      return {
        kind: "disconnected",
        reason: "The Windows runtime received a WSL Session.",
      };
    }

    let output: string;
    try {
      output = await this.runControl(session, ["inspect"]);
    } catch (error) {
      return {
        kind: "disconnected",
        reason: `Windows inspection failed: ${errorMessage(error)}`,
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
          reason:
            detail === "start_failed"
              ? await this.startFailureReason(session.id)
              : windowsInspectionReason(detail),
        };
      default:
        return {
          kind: "disconnected",
          reason: "The Windows Session runner returned an unknown response.",
        };
    }
  }

  async stop(session: StoredSession, force: boolean): Promise<boolean> {
    if (session.location.kind !== "windows") {
      return false;
    }
    try {
      const output = await this.runControl(session, [
        "stop",
        force ? "force" : "graceful",
      ]);
      return output.trim() === "verified";
    } catch {
      return false;
    }
  }

  async cleanup(session: StoredSession): Promise<void> {
    if (session.location.kind !== "windows") {
      return;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(this.stateDirectory(session.id), {
          recursive: true,
          force: true,
        });
        return;
      } catch {
        if (attempt < 9) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    // Cleanup is best effort after the managed process is confirmed stopped.
  }

  private async runControl(
    session: StoredSession,
    command: string[],
  ): Promise<string> {
    return await runCaptured(
      this.runnerPath(session.id),
      [...command, this.stateDirectory(session.id)],
    );
  }

  private stateDirectory(sessionId: string): string {
    return path.join(this.stateRoot, sessionId);
  }

  private runnerPath(sessionId: string): string {
    return path.join(this.stateDirectory(sessionId), "runner.exe");
  }

  private async startFailureReason(sessionId: string): Promise<string> {
    try {
      const detail = (
        await readFile(
          path.join(this.stateDirectory(sessionId), "start-error.txt"),
          "utf8",
        )
      ).trim();
      return detail
        ? `The Windows Session runner could not start the command: ${detail}`
        : windowsInspectionReason("start_failed");
    } catch {
      return windowsInspectionReason("start_failed");
    }
  }
}

async function writeJsonAtomically(
  destination: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, destination);
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

function windowsInspectionReason(value: string | undefined): string {
  switch (value) {
    case "identity_mismatch":
      return "The recorded Windows process identity no longer matches.";
    case "runner_unavailable":
      return "The Windows Session runner is unavailable.";
    case "start_failed":
      return "The Windows Session runner could not start the command.";
    default:
      return "HBOX could not verify the Windows process identity.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
