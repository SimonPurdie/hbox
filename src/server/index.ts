import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EntryService } from "./entry-service.js";
import { createHttpServer } from "./http-app.js";
import { WindowsActionLauncher } from "./launcher.js";
import { PowerShellFolderPicker } from "./picker.js";
import { PreferencesStore } from "./preferences.js";
import { defaultDataDirectory, Registry } from "./registry.js";
import { rebuildAndReplaceCurrentProcess } from "./restart.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { WslSessionRuntime } from "./wsl-session-runtime.js";
import {
  NativeLaunchBroker,
  registerNativeLaunchProtocol,
} from "./native-launch.js";

const HOST = "127.0.0.1";
const PORT = 4269;
const INSTANCE_ID = randomUUID();
const staticDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

try {
  const dataDirectory = defaultDataDirectory();
  const registry = new Registry(dataDirectory);
  const preferences = new PreferencesStore(dataDirectory);
  const launcher = new WindowsActionLauncher();
  const sessions = new SessionManager(
    new SessionStore(dataDirectory),
    new WslSessionRuntime(),
    launcher,
  );
  await sessions.initialize();
  const service = new EntryService(
    registry,
    new PowerShellFolderPicker(),
    launcher,
    console.warn,
    sessions,
  );
  await service.initialize();
  const protocolLauncher = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "protocol-launcher.exe",
  );
  const nativeLaunch = (await registerNativeLaunchProtocol(protocolLauncher))
    ? new NativeLaunchBroker((entryId, action) =>
        service.resolveBuiltInLaunch(entryId, action),
      )
    : undefined;

  let restarting = false;
  const server = createHttpServer(
    service,
    staticDirectory,
    console.error,
    () => {
      if (restarting) {
        return;
      }
      restarting = true;
      void rebuildAndReplaceCurrentProcess(server)
        .then(() => {
          sessions.close();
          process.exit(0);
        })
        .catch((restartError: unknown) => {
          console.error(
            restartError instanceof Error
              ? restartError.stack ?? restartError.message
              : String(restartError),
          );
          restarting = false;
        });
    },
    INSTANCE_ID,
    sessions,
    preferences,
    nativeLaunch,
  );
  server.listen(PORT, HOST, () => {
    console.log(`HBOX is ready at http://${HOST}:${PORT}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
