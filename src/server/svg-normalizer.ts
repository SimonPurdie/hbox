import { SaxesParser, type SaxesTagPlain } from "saxes";

export const ENTRY_ICON_COLOR = "#cf8f00";
export const ICON_NORMALIZER_VERSION = 1;
export const MAX_ICON_BYTES = 256 * 1024;

const MAX_ELEMENTS = 1_000;
const MAX_DEPTH = 64;
const MAX_ATTRIBUTE_LENGTH = 64 * 1024;

const ALLOWED_ELEMENTS = new Set([
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

const IGNORED_ELEMENTS = new Set([
  "defs",
  "metadata",
  "namedview",
  "title",
  "desc",
]);

const COMMON_ATTRIBUTES = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "opacity",
  "paint-order",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "transform",
  "vector-effect",
  "visibility",
  "display",
]);

const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  g: new Set(),
  path: new Set(["d", "pathLength"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "pathLength"]),
  circle: new Set(["cx", "cy", "r", "pathLength"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "pathLength"]),
  line: new Set(["x1", "y1", "x2", "y2", "pathLength"]),
  polyline: new Set(["points", "pathLength"]),
  polygon: new Set(["points", "pathLength"]),
};

const STYLE_PROPERTIES = new Set(
  [...COMMON_ATTRIBUTES].filter((property) => property !== "style"),
);

const PAINT_ATTRIBUTES = new Set(["fill", "stroke"]);

interface StackItem {
  name: string;
  ignored: boolean;
}

export class SvgNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgNormalizationError";
  }
}

export function normalizeEntryIcon(source: Buffer | string): Buffer {
  const sourceBuffer = Buffer.isBuffer(source)
    ? source
    : Buffer.from(source, "utf8");
  if (sourceBuffer.byteLength > MAX_ICON_BYTES) {
    throw new SvgNormalizationError("SVG icons must be 256 KiB or smaller.");
  }

  const input = sourceBuffer.toString("utf8");
  const parser = new SaxesParser({ xmlns: false });
  const output: string[] = [];
  const stack: StackItem[] = [];
  let failure: Error | null = null;
  let elementCount = 0;
  let rootSeen = false;

  const fail = (message: string): void => {
    failure ??= new SvgNormalizationError(message);
  };

  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.on("doctype", () => {
    fail("DOCTYPE declarations are not supported.");
  });
  parser.on("processinginstruction", ({ target }) => {
    if (target.toLowerCase() !== "xml") {
      fail("Processing instructions are not supported.");
    }
  });
  parser.on("cdata", () => {
    fail("CDATA is not supported.");
  });
  parser.on("text", (text) => {
    if (text.trim() && !stack.some((item) => item.ignored)) {
      fail("Text content is not supported.");
    }
  });
  parser.on("opentag", (tag) => {
    if (failure) {
      return;
    }
    if (stack.length >= MAX_DEPTH) {
      fail(`SVG nesting must not exceed ${MAX_DEPTH} elements.`);
      return;
    }

    const parentIgnored = stack.some((item) => item.ignored);
    const localName = tag.name.split(":").at(-1)?.toLowerCase() ?? "";
    if (parentIgnored || IGNORED_ELEMENTS.has(localName)) {
      stack.push({ name: localName, ignored: true });
      return;
    }

    elementCount += 1;
    if (elementCount > MAX_ELEMENTS) {
      fail(`SVG icons must not contain more than ${MAX_ELEMENTS} elements.`);
      return;
    }

    if (!rootSeen) {
      if (tag.name.toLowerCase() !== "svg") {
        fail("The document root must be an SVG element.");
        return;
      }
      rootSeen = true;
      output.push(serializeRoot(tag));
      stack.push({ name: "svg", ignored: false });
      return;
    }

    if (localName === "svg" || !ALLOWED_ELEMENTS.has(localName)) {
      fail(`Unsupported SVG element: ${tag.name}.`);
      return;
    }

    output.push(`<${localName}${serializeAttributes(localName, tag.attributes)}>`);
    stack.push({ name: localName, ignored: false });
  });
  parser.on("closetag", () => {
    if (failure) {
      return;
    }
    const item = stack.pop();
    if (!item) {
      fail("SVG elements are not balanced.");
      return;
    }
    if (!item.ignored) {
      output.push(`</${item.name}>`);
    }
  });

  try {
    parser.write(input).close();
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
  }

  if (failure) {
    throw new SvgNormalizationError(failure.message);
  }
  if (!rootSeen || stack.length !== 0) {
    throw new SvgNormalizationError("The SVG document is incomplete.");
  }

  const normalized = `${output.join("")}\n`;
  if (Buffer.byteLength(normalized) > MAX_ICON_BYTES) {
    throw new SvgNormalizationError(
      "The normalized SVG exceeds the 256 KiB limit.",
    );
  }
  return Buffer.from(normalized, "utf8");
}

function serializeRoot(tag: SaxesTagPlain): string {
  const viewBox = normalizedViewBox(tag.attributes);
  const attributes = serializeCommonAttributes(tag.attributes, new Set([
    ...COMMON_ATTRIBUTES,
    "viewBox",
    "viewbox",
    "width",
    "height",
    "preserveAspectRatio",
    "xmlns",
    "version",
    "id",
  ]));

  const hasFill = hasPresentationAttribute(tag.attributes, "fill");
  const hasStroke = hasPresentationAttribute(tag.attributes, "stroke");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ' width="24"',
    ' height="24"',
    ` viewBox="${escapeAttribute(viewBox)}"`,
    ' preserveAspectRatio="xMidYMid meet"',
    hasFill ? "" : ` fill="${ENTRY_ICON_COLOR}"`,
    hasStroke ? "" : ' stroke="none"',
    attributes,
    ">",
  ].join("");
}

function normalizedViewBox(attributes: Record<string, string>): string {
  const rawViewBox = attributes.viewBox ?? attributes.viewbox;
  if (rawViewBox !== undefined) {
    const values = numberList(rawViewBox);
    if (values.length !== 4 || values[2]! <= 0 || values[3]! <= 0) {
      throw new SvgNormalizationError(
        "The SVG viewBox must contain four finite numbers with positive dimensions.",
      );
    }
    return values.join(" ");
  }

  const width = dimension(attributes.width);
  const height = dimension(attributes.height);
  if (width === null || height === null) {
    throw new SvgNormalizationError(
      "The SVG must define a valid viewBox or positive width and height.",
    );
  }
  return `0 0 ${width} ${height}`;
}

function serializeAttributes(
  element: string,
  attributes: Record<string, string>,
): string {
  const allowed = ELEMENT_ATTRIBUTES[element];
  if (!allowed) {
    throw new SvgNormalizationError(`Unsupported SVG element: ${element}.`);
  }

  return serializeCommonAttributes(attributes, new Set([
    ...allowed,
    ...COMMON_ATTRIBUTES,
    "id",
  ]));
}

function serializeCommonAttributes(
  attributes: Record<string, string>,
  allowed: ReadonlySet<string>,
): string {
  const normalized = new Map<string, string>();

  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = canonicalAttributeName(rawName);
    if (rawValue.length > MAX_ATTRIBUTE_LENGTH) {
      throw new SvgNormalizationError(
        `SVG attribute ${rawName} exceeds the size limit.`,
      );
    }
    if (name.startsWith("xmlns") || name === "id") {
      continue;
    }
    if (isEditorAttribute(name)) {
      continue;
    }
    if (name === "class" || name.startsWith("on") || name.includes(":")) {
      throw new SvgNormalizationError(`Unsupported SVG attribute: ${rawName}.`);
    }
    if (!allowed.has(name)) {
      throw new SvgNormalizationError(`Unsupported SVG attribute: ${rawName}.`);
    }
    if (name === "style") {
      for (const [property, value] of parseStyle(rawValue)) {
        normalized.set(property, normalizeAttribute(property, value));
      }
    } else if (
      name !== "viewBox" &&
      name !== "viewbox" &&
      name !== "width" &&
      name !== "height" &&
      name !== "preserveAspectRatio" &&
      name !== "version"
    ) {
      normalized.set(name, normalizeAttribute(name, rawValue));
    }
  }

  return [...normalized.entries()]
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function isEditorAttribute(name: string): boolean {
  return (
    name === "xml:space" ||
    name.startsWith("inkscape:") ||
    name.startsWith("sodipodi:")
  );
}

function parseStyle(style: string): Array<[string, string]> {
  const declarations: Array<[string, string]> = [];
  for (const part of style.split(";")) {
    if (!part.trim()) {
      continue;
    }
    const separator = part.indexOf(":");
    if (separator <= 0) {
      throw new SvgNormalizationError("The SVG style attribute is invalid.");
    }
    const property = canonicalAttributeName(part.slice(0, separator).trim());
    const value = part.slice(separator + 1).trim();
    if (!STYLE_PROPERTIES.has(property) || !value) {
      throw new SvgNormalizationError(
        `Unsupported SVG style property: ${property || "(empty)"}.`,
      );
    }
    declarations.push([property, value]);
  }
  return declarations;
}

function normalizeAttribute(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SvgNormalizationError(`SVG attribute ${name} must not be empty.`);
  }
  if (/url\s*\(|var\s*\(|javascript:|data:/i.test(trimmed)) {
    throw new SvgNormalizationError(
      `SVG attribute ${name} contains an unsupported reference.`,
    );
  }
  if (PAINT_ATTRIBUTES.has(name)) {
    const paint = trimmed.toLowerCase();
    if (paint === "none") {
      return "none";
    }
    if (paint === "transparent") {
      return "none";
    }
    return ENTRY_ICON_COLOR;
  }
  return trimmed;
}

function hasPresentationAttribute(
  attributes: Record<string, string>,
  property: string,
): boolean {
  if (
    Object.keys(attributes).some(
      (attribute) => canonicalAttributeName(attribute) === property,
    )
  ) {
    return true;
  }
  const style = attributes.style;
  return (
    style !== undefined &&
    parseStyle(style).some(([candidate]) => candidate === property)
  );
}

function canonicalAttributeName(name: string): string {
  const lower = name.toLowerCase();
  const canonical: Readonly<Record<string, string>> = {
    viewbox: "viewBox",
    pathlength: "pathLength",
    preserveaspectratio: "preserveAspectRatio",
  };
  return canonical[lower] ?? lower;
}

function numberList(value: string): number[] {
  const parts = value.trim().split(/[\s,]+/);
  if (parts.length === 1 && parts[0] === "") {
    return [];
  }
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite) ? numbers : [];
}

function dimension(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/i.exec(value);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
