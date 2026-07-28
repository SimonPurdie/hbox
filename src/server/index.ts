import path from "node:path";
import { fileURLToPath } from "node:url";
import { EntryService } from "./entry-service.js";
import { createHttpServer } from "./http-app.js";
import { WindowsActionLauncher } from "./launcher.js";
import { PowerShellFolderPicker } from "./picker.js";
import { defaultDataDirectory, Registry } from "./registry.js";
import { replaceCurrentProcess } from "./restart.js";

const HOST = "127.0.0.1";
const PORT = 4269;
const staticDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

try {
  const registry = new Registry(defaultDataDirectory());
  const service = new EntryService(
    registry,
    new PowerShellFolderPicker(),
    new WindowsActionLauncher(),
  );
  await service.initialize();

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
      void replaceCurrentProcess(server)
        .then(() => {
          process.exit(0);
        })
        .catch((restartError: unknown) => {
          console.error(
            restartError instanceof Error
              ? restartError.stack ?? restartError.message
              : String(restartError),
          );
          process.exitCode = 1;
        });
    },
  );
  server.listen(PORT, HOST, () => {
    console.log(`HBOX is ready at http://${HOST}:${PORT}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
