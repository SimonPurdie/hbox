import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  ActionNotFoundError,
  EntryNotFoundError,
  EntryService,
  EntryUnavailableError,
  InvalidPinOrderError,
} from "./entry-service.js";
import { PickerBusyError } from "./picker.js";
import {
  SessionActionUnavailableError,
  SessionConflictError,
  type SessionManager,
  SessionNotFoundError,
} from "./session-manager.js";

const ACTION_PATTERN = /^\/api\/entries\/([^/]+)\/actions\/([^/]+)$/;
const ICON_PATTERN = /^\/api\/entries\/([^/]+)\/icon$/;
const PIN_PATTERN = /^\/api\/entries\/([^/]+)\/pin$/;
const ENTRY_PATTERN = /^\/api\/entries\/([^/]+)$/;
const SESSION_ACTION_PATTERN =
  /^\/api\/sessions\/([^/]+)\/(open|stop|restart|recheck)$/;
const SESSION_PATTERN = /^\/api\/sessions\/([^/]+)$/;
const MAX_JSON_BODY_BYTES = 64 * 1024;

class InvalidRequestError extends Error {}

export function createHttpServer(
  service: EntryService,
  staticDirectory: string,
  error: (message: string) => void = console.error,
  restart?: () => void,
  instanceId: string = `${process.pid}`,
  sessions?: SessionManager,
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

      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, { instanceId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        sendJson(
          response,
          200,
          sessions ? await sessions.listSessions() : [],
        );
        return;
      }

      if (
        request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "DELETE"
      ) {
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
          const body = Buffer.from(JSON.stringify({ instanceId }));
          response.writeHead(202, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.byteLength,
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.end(body, () => setImmediate(restart));
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

        const pinMatch = PIN_PATTERN.exec(url.pathname);
        if (pinMatch) {
          const entryId = decodeURIComponent(pinMatch[1] ?? "");
          await service.pinEntry(entryId);
          response.writeHead(204).end();
          return;
        }

        const actionMatch = ACTION_PATTERN.exec(url.pathname);
        if (actionMatch) {
          const entryId = decodeURIComponent(actionMatch[1] ?? "");
          const action = decodeURIComponent(actionMatch[2] ?? "");
          await service.performAction(entryId, action);
          response.writeHead(202).end();
          return;
        }

        const sessionActionMatch = SESSION_ACTION_PATTERN.exec(
          url.pathname,
        );
        if (sessionActionMatch && sessions) {
          const sessionId = decodeURIComponent(
            sessionActionMatch[1] ?? "",
          );
          switch (sessionActionMatch[2]) {
            case "open":
              await sessions.openSession(sessionId);
              break;
            case "stop":
              await sessions.stopSession(sessionId);
              break;
            case "restart":
              await sessions.restartSession(sessionId);
              break;
            case "recheck":
              await sessions.recheckSession(sessionId);
              break;
          }
          response.writeHead(202).end();
          return;
        }
      }

      if (request.method === "PUT" && url.pathname === "/api/pins/order") {
        await service.reorderPinnedEntries(await readPinOrder(request));
        response.writeHead(204).end();
        return;
      }

      if (request.method === "DELETE") {
        const sessionMatch = SESSION_PATTERN.exec(url.pathname);
        if (sessionMatch && sessions) {
          const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
          await sessions.forgetSession(sessionId);
          response.writeHead(204).end();
          return;
        }

        const pinMatch = PIN_PATTERN.exec(url.pathname);
        if (pinMatch) {
          const entryId = decodeURIComponent(pinMatch[1] ?? "");
          await service.unpinEntry(entryId);
          response.writeHead(204).end();
          return;
        }

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
      if (caught instanceof ActionNotFoundError) {
        sendJson(response, 404, { error: "action_not_found" });
        return;
      }
      if (caught instanceof SessionNotFoundError) {
        sendJson(response, 404, { error: "session_not_found" });
        return;
      }
      if (caught instanceof SessionConflictError) {
        sendJson(response, 409, { error: "session_conflict" });
        return;
      }
      if (caught instanceof SessionActionUnavailableError) {
        sendJson(response, 409, {
          error: "session_action_unavailable",
        });
        return;
      }
      if (caught instanceof PickerBusyError) {
        sendJson(response, 409, { error: "picker_busy" });
        return;
      }
      if (
        caught instanceof InvalidRequestError ||
        caught instanceof InvalidPinOrderError
      ) {
        sendJson(response, 400, { error: "invalid_pin_order" });
        return;
      }

      error(caught instanceof Error ? caught.stack ?? caught.message : String(caught));
      sendJson(response, 500, { error: "internal_error" });
    }
  });
}

async function readPinOrder(
  request: IncomingMessage,
): Promise<string[]> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new InvalidRequestError("Request body is too large.");
    }
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRequestError("Request body is not valid JSON.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("entryIds" in value) ||
    !Array.isArray(value.entryIds) ||
    !value.entryIds.every((entryId) => typeof entryId === "string")
  ) {
    throw new InvalidRequestError("Pinned Entry IDs are invalid.");
  }
  return value.entryIds;
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
