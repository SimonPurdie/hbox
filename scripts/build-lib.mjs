import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const BUILD_MANIFEST = ".hbox-build.json";
export const BUILD_MANIFEST_VERSION = 1;

const commonRequiredOutputs = [
  "public/index.html",
  "public/styles.css",
  "public/assets/client/app.js",
  "public/assets/shared/wire.js",
  "public/assets/vendor/coloris.min.css",
  "public/assets/vendor/coloris.min.js",
  "server/index.js",
  "server/hbox-contract.md",
  "server/session-launcher.vbs",
  "server/wsl-scripts/run.sh",
  "server/wsl-scripts/inspect.sh",
  "server/wsl-scripts/stop.sh",
  "server/wsl-scripts/cleanup.sh",
  "shared/wire.js",
];

export async function computeBuildFingerprint({
  projectDirectory,
  platform = process.platform,
  architecture = process.arch,
  nodeVersion = process.version,
  environment = process.env,
}) {
  const hash = createHash("sha256");
  const files = await buildInputFiles(projectDirectory);
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(path.join(projectDirectory, relativePath)));
    hash.update("\0");
  }

  const tools = {
    platform,
    architecture,
    nodeVersion,
    packages: await packageVersions(projectDirectory, [
      "typescript",
      "@melloware/coloris",
      "saxes",
    ]),
    csharpCompiler:
      platform === "win32"
        ? await compilerIdentity(environment)
        : null,
  };
  hash.update(JSON.stringify(tools));
  return hash.digest("hex");
}

export async function isBuildCurrent({
  outputDirectory,
  fingerprint,
  platform = process.platform,
  architecture = process.arch,
}) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(outputDirectory, BUILD_MANIFEST), "utf8"),
    );
  } catch {
    return false;
  }
  if (
    !isManifest(manifest) ||
    manifest.fingerprint !== fingerprint ||
    manifest.platform !== platform ||
    manifest.architecture !== architecture
  ) {
    return false;
  }

  const outputs = new Set(manifest.outputs);
  for (const required of requiredBuildOutputs(platform)) {
    if (!outputs.has(required)) {
      return false;
    }
  }
  for (const relativePath of outputs) {
    try {
      if (
        !(await stat(path.join(outputDirectory, relativePath))).isFile()
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function writeBuildManifest({
  buildDirectory,
  fingerprint,
  platform = process.platform,
  architecture = process.arch,
}) {
  const outputs = await outputFiles(buildDirectory);
  const manifest = {
    version: BUILD_MANIFEST_VERSION,
    fingerprint,
    platform,
    architecture,
    outputs,
  };
  await writeFile(
    path.join(buildDirectory, BUILD_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function replaceBuildOutput({
  buildDirectory,
  outputDirectory,
  backupDirectory,
}) {
  let hasBackup = false;
  try {
    await rm(backupDirectory, { recursive: true, force: true });
    try {
      await rename(outputDirectory, backupDirectory);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await rename(buildDirectory, outputDirectory);
  } catch (error) {
    if (hasBackup) {
      await rename(backupDirectory, outputDirectory);
    }
    throw error;
  }

  if (hasBackup) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

export async function resolveCSharpCompiler(
  environment = process.env,
) {
  const windowsDirectory = environment.WINDIR ?? String.raw`C:\Windows`;
  const candidates = [
    path.win32.join(
      windowsDirectory,
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
    path.win32.join(
      windowsDirectory,
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe",
    ),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next standard .NET Framework location.
    }
  }
  throw new Error(
    "HBOX could not find the .NET Framework C# compiler. " +
      `Expected csc.exe at ${candidates.join(" or ")}.`,
  );
}

async function buildInputFiles(projectDirectory) {
  const files = [];
  for (const directory of ["src", "scripts"]) {
    await collectFiles(projectDirectory, directory, files);
  }
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.client.json",
    "tsconfig.server.json",
  ]) {
    files.push(file);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(projectDirectory, relativeDirectory, files) {
  const entries = await readdir(
    path.join(projectDirectory, relativeDirectory),
    { withFileTypes: true },
  );
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(projectDirectory, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

async function packageVersions(projectDirectory, packages) {
  const versions = {};
  for (const packageName of packages) {
    const packageJson = JSON.parse(
      await readFile(
        path.join(
          projectDirectory,
          "node_modules",
          ...packageName.split("/"),
          "package.json",
        ),
        "utf8",
      ),
    );
    versions[packageName] = packageJson.version;
  }
  return versions;
}

async function compilerIdentity(environment) {
  const compiler = await resolveCSharpCompiler(environment);
  const information = await stat(compiler);
  return {
    path: compiler,
    size: information.size,
    modifiedTimeMs: information.mtimeMs,
  };
}

async function outputFiles(directory) {
  const files = [];
  await collectOutputFiles(directory, "", files);
  return files
    .filter((relativePath) => relativePath !== BUILD_MANIFEST)
    .sort((left, right) => left.localeCompare(right));
}

async function collectOutputFiles(directory, relativeDirectory, files) {
  const current = path.join(directory, relativeDirectory);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectOutputFiles(directory, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

export function requiredBuildOutputs(platform) {
  return platform === "win32"
    ? [
        ...commonRequiredOutputs,
        "server/protocol-launcher.exe",
        "server/windows-session-runner.exe",
      ]
    : commonRequiredOutputs;
}

function isManifest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.version === BUILD_MANIFEST_VERSION &&
    typeof value.fingerprint === "string" &&
    typeof value.platform === "string" &&
    typeof value.architecture === "string" &&
    Array.isArray(value.outputs) &&
    value.outputs.length > 0 &&
    value.outputs.every(
      (output) =>
        typeof output === "string" &&
        output.length > 0 &&
        !path.isAbsolute(output) &&
        !output.split(/[\\/]/).includes(".."),
    )
  );
}
