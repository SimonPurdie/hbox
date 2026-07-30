import assert from "node:assert/strict";
import test from "node:test";
import {
  TAG_ICON_PRIORITY as serverTagPriority,
} from "../dist/server/types.js";
import {
  TAG_ICON_PRIORITY as clientTagPriority,
} from "../dist/public/assets/client/model.js";
import {
  isCommand,
  isEntryLocation,
  isUuid,
} from "../dist/server/validation.js";

test("client and server compile the same shared tag contract", () => {
  assert.deepEqual(clientTagPriority, serverTagPriority);
  assert.deepEqual(serverTagPriority, [
    "agent",
    "gamedev",
    "browser-extension",
    "desktop",
    "web",
    "script",
    "data",
  ]);
});

test("shared persistence primitives enforce canonical invariants", () => {
  assert.equal(
    isUuid("5f1801d8-039e-4d66-8691-b01cbe293fdd"),
    true,
  );
  assert.equal(isUuid("../outside"), false);

  assert.equal(isCommand(["npm", "run", "dev"]), true);
  assert.equal(isCommand(["npm", "", "dev"]), false);
  assert.equal(isCommand("npm run dev"), false);

  assert.equal(
    isEntryLocation({ kind: "windows", path: String.raw`E:\Project` }),
    true,
  );
  assert.equal(
    isEntryLocation({ kind: "windows", path: "relative" }),
    false,
  );
  assert.equal(
    isEntryLocation({
      kind: "wsl",
      distribution: "Ubuntu",
      path: "/home/simon/project",
    }),
    true,
  );
  assert.equal(
    isEntryLocation({
      kind: "wsl",
      distribution: "Ubuntu",
      path: "relative",
    }),
    false,
  );
});
