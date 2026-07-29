import { spawn } from "node:child_process";
import type { StoredSession } from "./session-store.js";

const RUNNER_SCRIPT = String.raw`
umask 077
session_id=$1
shift
state_root=${"$"}{XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
mkdir -p "$state_root" || exit 70
rm -f "$state_root/boot" "$state_root/pid" "$state_root/start" "$state_root/exit"
cat /proc/sys/kernel/random/boot_id > "$state_root/boot" || exit 70
HBOX_SESSION_ID=$session_id setsid /bin/bash -ic 'exec "$@"' hbox-session-command "$@" >> "$state_root/output.log" 2>&1 &
child_pid=$!
printf '%s\n' "$child_pid" > "$state_root/pid"
start_time=
attempt=0
while [ "$attempt" -lt 20 ]; do
  if [ -r "/proc/$child_pid/stat" ]; then
    stat_line=$(cat "/proc/$child_pid/stat")
    stat_tail=${"$"}{stat_line##*) }
    set -- $stat_tail
    start_time=${"$"}{20}
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
if [ -n "$start_time" ]; then
  printf '%s\n' "$start_time" > "$state_root/start"
fi
wait "$child_pid"
exit_code=$?
exit_tmp="$state_root/exit.$$"
printf '%s\n' "$exit_code" > "$exit_tmp"
mv "$exit_tmp" "$state_root/exit"
exit "$exit_code"
`;

const INSPECT_SCRIPT = String.raw`
session_id=$1
state_root=${"$"}{XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
if [ -r "$state_root/exit" ]; then
  IFS= read -r exit_code < "$state_root/exit"
  printf 'exited\t%s\n' "$exit_code"
  exit 0
fi
if [ ! -r "$state_root/boot" ] || [ ! -r "$state_root/pid" ] || [ ! -r "$state_root/start" ]; then
  printf 'pending\n'
  exit 0
fi
IFS= read -r expected_boot < "$state_root/boot"
IFS= read -r child_pid < "$state_root/pid"
IFS= read -r expected_start < "$state_root/start"
current_boot=$(cat /proc/sys/kernel/random/boot_id) || exit 70
if [ "$current_boot" != "$expected_boot" ]; then
  printf 'disconnected\twsl_restarted\n'
  exit 0
fi
case "$child_pid" in
  ''|*[!0-9]*)
    printf 'disconnected\tinvalid_identity\n'
    exit 0
    ;;
esac
if [ ! -r "/proc/$child_pid/stat" ] || [ ! -r "/proc/$child_pid/environ" ]; then
  printf 'missing\n'
  exit 0
fi
stat_line=$(cat "/proc/$child_pid/stat")
stat_tail=${"$"}{stat_line##*) }
set -- $stat_tail
process_group=$3
current_start=${"$"}{20}
if [ "$current_start" != "$expected_start" ] || [ "$process_group" != "$child_pid" ]; then
  printf 'disconnected\tidentity_mismatch\n'
  exit 0
fi
if ! tr '\000' '\n' < "/proc/$child_pid/environ" | grep -F -x -q "HBOX_SESSION_ID=$session_id"; then
  printf 'disconnected\ttoken_mismatch\n'
  exit 0
fi
if ! kill -0 "$child_pid" 2>/dev/null; then
  printf 'missing\n'
  exit 0
fi
printf 'alive\t%s\n' "$child_pid"
`;

const STOP_SCRIPT = String.raw`
session_id=$1
signal_name=$2
state_root=${"$"}{XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
if [ ! -r "$state_root/boot" ] || [ ! -r "$state_root/pid" ] || [ ! -r "$state_root/start" ]; then
  printf 'not_verified\n'
  exit 3
fi
IFS= read -r expected_boot < "$state_root/boot"
IFS= read -r child_pid < "$state_root/pid"
IFS= read -r expected_start < "$state_root/start"
current_boot=$(cat /proc/sys/kernel/random/boot_id) || exit 70
if [ "$current_boot" != "$expected_boot" ]; then
  printf 'not_verified\n'
  exit 3
fi
case "$child_pid" in
  ''|*[!0-9]*)
    printf 'not_verified\n'
    exit 3
    ;;
esac
if [ ! -r "/proc/$child_pid/stat" ] || [ ! -r "/proc/$child_pid/environ" ]; then
  printf 'already_stopped\n'
  exit 0
fi
stat_line=$(cat "/proc/$child_pid/stat")
stat_tail=${"$"}{stat_line##*) }
set -- $stat_tail
process_group=$3
current_start=${"$"}{20}
if [ "$current_start" != "$expected_start" ] || [ "$process_group" != "$child_pid" ]; then
  printf 'not_verified\n'
  exit 3
fi
if ! tr '\000' '\n' < "/proc/$child_pid/environ" | grep -F -x -q "HBOX_SESSION_ID=$session_id"; then
  printf 'not_verified\n'
  exit 3
fi
if /usr/bin/pkill --signal "$signal_name" --pgroup "$child_pid"; then
  printf 'signalled\n'
  exit 0
fi
if ! kill -0 "$child_pid" 2>/dev/null; then
  printf 'already_stopped\n'
  exit 0
fi
printf 'not_verified\n'
exit 3
`;

const CLEANUP_SCRIPT = String.raw`
session_id=$1
case "$session_id" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
state_root=${"$"}{XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
rm -rf "$state_root"
`;

export type RuntimeInspection =
  | { kind: "pending" }
  | { kind: "alive"; pid: number }
  | { kind: "exited"; exitCode: number | null }
  | { kind: "missing" }
  | { kind: "disconnected"; reason: string };

export interface SessionRuntime {
  start(session: StoredSession): Promise<void>;
  inspect(session: StoredSession): Promise<RuntimeInspection>;
  stop(session: StoredSession, force: boolean): Promise<boolean>;
  cleanup(session: StoredSession): Promise<void>;
}

export class WslSessionRuntime implements SessionRuntime {
  async start(session: StoredSession): Promise<void> {
    await spawnDetached("wsl.exe", [
      "--distribution",
      session.location.distribution,
      "--cd",
      session.location.path,
      "--exec",
      "/bin/sh",
      "-c",
      RUNNER_SCRIPT,
      "hbox-session-runner",
      session.id,
      ...session.definition.command,
    ]);
  }

  async inspect(session: StoredSession): Promise<RuntimeInspection> {
    let output: string;
    try {
      output = await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        INSPECT_SCRIPT,
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
    try {
      const output = await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        STOP_SCRIPT,
        "hbox-session-stop",
        session.id,
        force ? "KILL" : "TERM",
      ]);
      return output.trim() === "signalled" ||
        output.trim() === "already_stopped";
    } catch {
      return false;
    }
  }

  async cleanup(session: StoredSession): Promise<void> {
    try {
      await runCaptured("wsl.exe", [
        "--distribution",
        session.location.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        CLEANUP_SCRIPT,
        "hbox-session-cleanup",
        session.id,
      ]);
    } catch {
      // Runtime cleanup is best effort after the process is confirmed stopped.
    }
  }
}

async function spawnDetached(
  command: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
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
