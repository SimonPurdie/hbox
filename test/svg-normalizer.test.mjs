import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ENTRY_ICON_COLOR,
  SvgNormalizationError,
  normalizeEntryIcon,
} from "../dist/server/svg-normalizer.js";

test("normalizes common SVG shapes, paint, dimensions, and editor metadata", () => {
  const normalized = normalizeEntryIcon(`<?xml version="1.0"?>
    <svg width="48px" height="24" fill="none"
      style="stroke:#123;stroke-width:1.5"
      xmlns="http://www.w3.org/2000/svg"
      xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
      inkscape:version="1.4">
      <defs><linearGradient id="unused"/></defs>
      <g opacity="0.8" transform="translate(1 2)">
        <path id="line" d="M0 0h46" style="fill:none;stroke:white"/>
        <circle cx="12" cy="8" r="3" fill="#f00" stroke="none"/>
      </g>
    </svg>`).toString();

  assert.match(normalized, /width="24" height="24"/);
  assert.match(normalized, /viewBox="0 0 48 24"/);
  assert.match(normalized, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(normalized, /stroke="#cf8f00"/);
  assert.match(normalized, /fill="#cf8f00"/);
  assert.match(normalized, /fill="none"/);
  assert.doesNotMatch(normalized, /#123|#f00|white|inkscape|linearGradient|id=/);
});

test("rejects unsafe, linked, malformed, and unsupported SVG content", () => {
  const invalid = [
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 24 24"><image href="https://example.com/x"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M0 0" onclick="x()"/></svg>',
    '<svg viewBox="0 0 24 24"><path fill="url(#gradient)" d="M0 0"/></svg>',
    '<svg><path d="M0 0"/></svg>',
    '<svg viewBox="0 0 0 24"><path d="M0 0"/></svg>',
    "<svg viewBox=\"0 0 24 24\"><path></svg>",
  ];

  for (const source of invalid) {
    assert.throws(() => normalizeEntryIcon(source), SvgNormalizationError);
  }
});

test("all built-in tag icons use only the canonical Entry icon paint", async () => {
  const icons = [
    "tag-agent",
    "tag-gamedev",
    "tag-browser-extension",
    "tag-desktop",
    "tag-web",
    "tag-script",
    "tag-data",
    "fallback",
  ];
  for (const icon of icons) {
    const source = await readFile(
      path.resolve(`src/public/assets/icons/${icon}.svg`),
      "utf8",
    );
    assert.doesNotThrow(() => normalizeEntryIcon(source));
    assert.match(source, /viewBox="0 0 24 24"/);
    const paints = [
      ...source.matchAll(/\b(?:fill|stroke)="([^"]+)"/g),
    ].map((match) => match[1]);
    assert.ok(paints.length > 0);
    assert.ok(
      paints.every(
        (paint) => paint === "none" || paint === ENTRY_ICON_COLOR,
      ),
      `${icon} contains a non-canonical paint`,
    );
  }
});
