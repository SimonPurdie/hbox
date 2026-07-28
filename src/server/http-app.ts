import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  EntryNotFoundError,
  EntryService,
  EntryUnavailableError,
} from "./entry-service.js";
import { PickerBusyError } from "./picker.js";
import type { ActionName } from "./types.js";

const ACTION_PATTERN =
  /^\/api\/entries\/([^/]+)\/actions\/(folder|terminal)$/;
const ICON_PATTERN = /^\/api\/entries\/([^/]+)\/icon$/;
const ENTRY_PATTERN = /^\/api\/entries\/([^/]+)$/;

export function createHttpServer(
  service: EntryService,
  staticDirectory: string,
  error: (message: string) => void = console.error,
  restart?: () => void,
): Server {
  return createServer(async (request, response) => {
    setSecurityHeaders(response);

    try {
      if (!isAllowedHost(request.headers.host)) {
        sendJson(response, 421, { error: "invalid_host" });
        return;
      }

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host}`,
      );

      if (request.method === "GET" && url.pathname === "/api/entries") {
        sendJson(response, 200, await service.listEntries());
        return;
      }

      if (request.method === "POST" || request.method === "DELETE") {
        if (!hasAllowedOrigin(request)) {
          sendJson(response, 403, { error: "invalid_origin" });
          return;
        }
      }

      if (request.method === "POST") {
        if (url.pathname === "/api/restart") {
          if (!restart) {
            sendJson(response, 501, { error: "restart_unavailable" });
            return;
          }
          response.writeHead(202, {
            "Content-Length": "0",
            Connection: "close",
          });
          response.end(() => setImmediate(restart));
          return;
        }

        if (url.pathname === "/api/entries") {
          const result = await service.registerFromPicker();
          if (result === null) {
            response.writeHead(204).end();
          } else {
            sendJson(response, result.created ? 201 : 200, result.entry);
          }
          return;
        }

        const actionMatch = ACTION_PATTERN.exec(url.pathname);
        if (actionMatch) {
          const entryId = decodeURIComponent(actionMatch[1] ?? "");
          const action = actionMatch[2] as ActionName;
          await service.performAction(entryId, action);
          response.writeHead(202).end();
          return;
        }
      }

      if (request.method === "DELETE") {
        const entryMatch = ENTRY_PATTERN.exec(url.pathname);
        if (entryMatch) {
          const entryId = decodeURIComponent(entryMatch[1] ?? "");
          await service.removeEntry(entryId);
          response.writeHead(204).end();
          return;
        }
      }

      if (request.method === "GET") {
        const iconMatch = ICON_PATTERN.exec(url.pathname);
        if (iconMatch) {
          const entryId = decodeURIComponent(iconMatch[1] ?? "");
          const icon = await service.readCachedIcon(entryId);
          response.writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Content-Length": icon.byteLength,
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(icon);
          return;
        }

        const entryMatch = ENTRY_PATTERN.exec(url.pathname);
        if (entryMatch) {
          const entryId = decodeURIComponent(entryMatch[1] ?? "");
          sendJson(response, 200, await service.getEntryDetails(entryId));
          return;
        }

        if (await serveStaticFile(response, staticDirectory, url.pathname)) {
          return;
        }
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (caught) {
      if (caught instanceof EntryUnavailableError) {
        sendJson(response, 409, { error: "entry_unavailable" });
        return;
      }
      if (caught instanceof EntryNotFoundError) {
        sendJson(response, 404, { error: "entry_not_found" });
        return;
      }
      if (caught instanceof PickerBusyError) {
        sendJson(response, 409, { error: "picker_busy" });
        return;
      }

      error(caught instanceof Error ? caught.stack ?? caught.message : String(caught));
      sendJson(response, 500, { error: "internal_error" });
    }
  });
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  return Boolean(host && request.headers.origin === `http://${host}`);
}

function isAllowedHost(host: string | undefined): boolean {
  return Boolean(host && /^127\.0\.0\.1(?::\d+)?$/.test(host));
}

async function serveStaticFile(
  response: ServerResponse,
  staticDirectory: string,
  pathname: string,
): Promise<boolean> {
  let relativePath: string;
  try {
    relativePath =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    return false;
  }

  const root = path.resolve(staticDirectory);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return false;
  }

  try {
    if (!(await stat(candidate)).isFile()) {
      return false;
    }
    const content = await readFile(candidate);
    response.writeHead(200, {
      "Content-Type": contentType(candidate),
      "Content-Length": content.byteLength,
      "Cache-Control": "no-cache",
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLocaleLowerCase("en-US")) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
