import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultEnvFiles = [".env", ".env.local"];

export function loadLocalEnv(options = {}) {
  if (process.env.NEARBY_LOAD_DOTENV === "0") {
    return [];
  }

  const protectedKeys = new Set(Object.keys(process.env));
  const loaded = [];

  for (const envFile of envFiles(options.files)) {
    const envPath = resolve(projectRoot, envFile);
    if (!existsSync(envPath)) {
      continue;
    }

    const entries = parseEnvFile(readFileSync(envPath, "utf8"), envPath);
    for (const [key, value] of Object.entries(entries)) {
      if (!protectedKeys.has(key)) {
        process.env[key] = value;
      }
    }
    loaded.push(envPath);
  }

  return loaded;
}

export function parseEnvFile(contents, sourceName = ".env") {
  const entries = {};
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const equalIndex = normalized.indexOf("=");
    if (equalIndex === -1) {
      throw new Error(`${sourceName}:${index + 1} is missing '='.`);
    }

    const key = normalized.slice(0, equalIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${sourceName}:${index + 1} has an invalid environment variable name.`);
    }

    entries[key] = parseEnvValue(normalized.slice(equalIndex + 1).trim());
  });

  return entries;
}

function envFiles(files) {
  const configured = files || process.env.NEARBY_ENV_FILE;
  if (!configured) {
    return defaultEnvFiles;
  }

  return (Array.isArray(configured) ? configured : String(configured).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvValue(value) {
  if (!value) {
    return "";
  }

  if (value.startsWith('"')) {
    return parseQuotedValue(value, '"').replace(/\\([nrt"\\])/g, (_, escaped) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    });
  }

  if (value.startsWith("'")) {
    return parseQuotedValue(value, "'");
  }

  return stripInlineComment(value).trim();
}

function parseQuotedValue(value, quote) {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }

    if (char === quote && !escaped) {
      return value.slice(1, index);
    }

    escaped = false;
  }

  throw new Error(`Unterminated quoted environment variable value.`);
}

function stripInlineComment(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }

  return value;
}
