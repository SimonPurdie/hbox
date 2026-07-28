import { spawn } from "node:child_process";

const PICKER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder to add to HBOX'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Write($dialog.SelectedPath)
}
$dialog.Dispose()
`;

export class PickerBusyError extends Error {
  constructor() {
    super("A folder picker is already open.");
  }
}

export interface FolderPicker {
  pick(): Promise<string | null>;
}

export class PowerShellFolderPicker implements FolderPicker {
  private active = false;

  async pick(): Promise<string | null> {
    if (this.active) {
      throw new PickerBusyError();
    }

    this.active = true;
    try {
      const output = await runPicker();
      const selectedPath = output.trim();
      return selectedPath || null;
    } finally {
      this.active = false;
    }
  }
}

async function runPicker(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        PICKER_SCRIPT,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderr).toString("utf8").trim() ||
            `The folder picker exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}
