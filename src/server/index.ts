import path from "node:path";
import { fileURLToPath } from "node:url";
import { EntryService } from "./entry-service.js";
import { createHttpServer } from "./http-app.js";
import { WindowsActionLauncher } from "./launcher.js";
import { PowerShellFolderPicker } from "./picker.js";
import { defaultDataDirectory, Registry } from "./registry.js";

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

  const server = createHttpServer(service, staticDirectory);
  server.listen(PORT, HOST, () => {
    console.log(`HBOX is ready at http://${HOST}:${PORT}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
