#!/usr/bin/env bun
/**
 * Generate sample rows for canonical schemas using Claude.
 *
 * Per schema:
 *   1. read canonical schema from /v1/snapshot
 *   2. target row count = min(100, 10 + field_count)
 *   3. prompt Claude Haiku 4.5 to draft N rows as a JSON array
 *   4. shape-validate each row via validate.ts; drop failures
 *   5. write samples/<descriptive_name>.json and update manifest.json
 *
 * Usage:
 *   bun generate.ts --schemas Message,Recipe,Book
 *   bun generate.ts --all
 *   bun generate.ts --schemas-file <path>     # one descriptive_name per line
 *
 * Env (required):
 *   EXEMEM_DEV_API_KEY   — schema_service auth
 *   ANTHROPIC_API_KEY    — Anthropic API auth
 *
 * Env (optional):
 *   SCHEMA_SERVICE_URL   — override snapshot URL
 *   GENERATOR_MODEL      — override model (default: claude-haiku-4-5)
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchSnapshot,
  indexByDescriptiveName,
  validateRow,
  type CanonicalSchema,
  type FieldType,
} from "./validate";

const DEFAULT_SCHEMA_SERVICE_URL =
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";
const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_ROWS = 100;
const MIN_PASS_RATIO = 0.5;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SAMPLES_DIR = resolve(REPO_ROOT, "samples");
const MANIFEST_PATH = resolve(REPO_ROOT, "manifest.json");

interface CliArgs {
  schemas?: string[];
  all: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--schemas") {
      const v = argv[++i];
      if (!v) throw new Error("--schemas requires a comma-separated list");
      out.schemas = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--schemas-file") {
      throw new Error("--schemas-file: read the file and pass --schemas instead");
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: bun generate.ts [--schemas <name,name,...>] [--all]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.all && !out.schemas) {
    throw new Error("pass --schemas <list> or --all");
  }
  return out;
}

function fieldTypeLabel(t: FieldType): string {
  if (typeof t === "string") return t;
  if ("Array" in t) return `Array<${fieldTypeLabel(t.Array)}>`;
  if ("OneOf" in t) return t.OneOf.map(fieldTypeLabel).join(" | ");
  return JSON.stringify(t);
}

function buildPrompt(schema: CanonicalSchema, n: number): string {
  const fields = Object.entries(schema.field_types)
    .map(([name, t]) => {
      const desc = schema.field_descriptions?.[name] ?? "";
      const cleanDesc = desc
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      return `  - ${name} (${fieldTypeLabel(t)}): ${cleanDesc}`;
    })
    .join("\n");
  return `You are generating sample rows for the canonical schema "${schema.descriptive_name}".

Fields (name, type, description):
${fields}

Generate ${n} plausible, varied row objects as a JSON array. Each row MUST be a JSON object containing EXACTLY these field names (no extras, no omissions), with values that match the declared types:
- String  → JSON string (never null)
- Integer → JSON integer (no decimal point)
- Float   → JSON number (with a decimal point)
- Boolean → JSON true or false
- Null    → JSON null
- Array<T> → JSON array of values of type T (empty array [] is fine; never null)
- "T | Null" → either a value of type T, or null

CRITICAL — null handling:
- A field whose declared type is String must ALWAYS receive a string value, NEVER null. If the value would naturally be absent (e.g. no BCC recipient on a message, no error on a successful action), use an empty string "" — NOT null.
- Only fields whose declared type literally says "Null" or "| Null" are allowed to be null.

Constraints:
- Strings must be realistic but ANONYMIZED. No real names, real email addresses, real phone numbers, real street addresses, real ISBNs, or other identifying real-world data. Use clearly synthetic-looking placeholders ("Jane Doe", "user-1234", "example.com", "+1-555-0123", "123 Example St").
- Numbers must be in plausible ranges for the field's meaning.
- Dates must be ISO-8601 strings if represented as String.
- Vary the rows — do not return ${n} copies of the same row.

Output ONLY the JSON array. No preamble. No commentary. No markdown fences. The first character of your response MUST be "[" and the last MUST be "]".`;
}

function extractJsonArray(text: string): string {
  // Strip ```json fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("no JSON array found in model output");
  }
  return body.slice(start, end + 1);
}

interface GenerateResult {
  descriptive_name: string;
  identity_hash: string;
  rows: unknown[];
  errors: { rowIndex: number; reason: string }[];
}

async function generateForSchema(
  client: Anthropic,
  model: string,
  schema: CanonicalSchema,
): Promise<GenerateResult> {
  const fieldCount = Object.keys(schema.field_types).length;
  const target = Math.min(MAX_ROWS, 10 + fieldCount);

  const prompt = buildPrompt(schema, target);

  const tokenBudget = Math.min(
    16000,
    Math.max(4000, target * fieldCount * 60),
  );
  let response = await client.messages.create({
    model,
    max_tokens: tokenBudget,
    messages: [{ role: "user", content: prompt }],
  });
  let text =
    response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(text));
  } catch {
    // one retry with explicit nudge
    response = await client.messages.create({
      model,
      max_tokens: tokenBudget,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "Your previous response could not be parsed as a JSON array. Output ONLY the JSON array — first character must be '[', last character must be ']'. No fences, no commentary.",
        },
      ],
    });
    text =
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("") ?? "";
    parsed = JSON.parse(extractJsonArray(text));
  }

  if (!Array.isArray(parsed)) {
    throw new Error("model returned non-array JSON");
  }

  const rows: unknown[] = [];
  const errors: { rowIndex: number; reason: string }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const reason = validateRow(parsed[i], schema.field_types);
    if (reason) errors.push({ rowIndex: i, reason });
    else rows.push(parsed[i]);
  }

  return {
    descriptive_name: schema.descriptive_name,
    identity_hash: schema.identity_hash,
    rows,
    errors,
  };
}

interface ManifestSchemaEntry {
  descriptive_name: string;
  identity_hash: string;
  row_count: number;
  generated_at: string;
}

interface Manifest {
  generated_at: string;
  generator_model: string;
  snapshot_captured_at?: string;
  snapshot_url: string;
  schemas: ManifestSchemaEntry[];
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

async function writeManifest(m: Manifest) {
  m.schemas.sort((a, b) =>
    a.descriptive_name.localeCompare(b.descriptive_name),
  );
  await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.EXEMEM_DEV_API_KEY;
  if (!apiKey) throw new Error("EXEMEM_DEV_API_KEY is required");
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is required");

  const url = process.env.SCHEMA_SERVICE_URL ?? DEFAULT_SCHEMA_SERVICE_URL;
  const model = process.env.GENERATOR_MODEL ?? DEFAULT_MODEL;

  process.stderr.write(`fetching snapshot from ${url} ... `);
  const snap = await fetchSnapshot(url, apiKey);
  process.stderr.write(`${snap.schemas.length} schemas\n`);
  const byName = indexByDescriptiveName(snap);

  const targetNames: string[] = args.all
    ? [...byName.keys()].sort()
    : args.schemas!;

  for (const n of targetNames) {
    if (!byName.has(n)) {
      throw new Error(`schema "${n}" not in snapshot — refusing to proceed`);
    }
  }

  await mkdir(SAMPLES_DIR, { recursive: true });
  const client = new Anthropic({ apiKey: anthropicKey });

  const manifest: Manifest = (await loadManifest()) ?? {
    generated_at: new Date().toISOString(),
    generator_model: model,
    snapshot_url: url,
    schemas: [],
  };
  manifest.generated_at = new Date().toISOString();
  manifest.generator_model = model;
  manifest.snapshot_url = url;
  manifest.snapshot_captured_at = snap.captured_at;

  for (const name of targetNames) {
    const schema = byName.get(name)!;
    const target = Math.min(MAX_ROWS, 10 + Object.keys(schema.field_types).length);
    process.stderr.write(
      `generating ${name} (${schema.identity_hash.slice(0, 8)}, ${target} rows) ... `,
    );
    try {
      const res = await generateForSchema(client, model, schema);
      const total = res.rows.length + res.errors.length;
      const passRatio = total === 0 ? 0 : res.rows.length / total;
      if (passRatio < MIN_PASS_RATIO) {
        process.stderr.write(
          `SKIPPED — only ${res.rows.length}/${total} rows passed shape validation\n`,
        );
        for (const e of res.errors.slice(0, 3)) {
          process.stderr.write(`    row ${e.rowIndex}: ${e.reason}\n`);
        }
        continue;
      }
      const outPath = resolve(SAMPLES_DIR, `${name}.json`);
      await writeFile(outPath, JSON.stringify(res.rows, null, 2) + "\n");
      const existing = manifest.schemas.findIndex(
        (s) => s.descriptive_name === name,
      );
      const entry: ManifestSchemaEntry = {
        descriptive_name: name,
        identity_hash: schema.identity_hash,
        row_count: res.rows.length,
        generated_at: new Date().toISOString(),
      };
      if (existing >= 0) manifest.schemas[existing] = entry;
      else manifest.schemas.push(entry);
      process.stderr.write(`OK (${res.rows.length} rows, ${res.errors.length} dropped)\n`);
    } catch (e) {
      process.stderr.write(`FAIL — ${(e as Error).message}\n`);
    }
    await writeManifest(manifest);
  }

  // Make sure manifest reflects whatever sample files exist on disk so a
  // partial run doesn't leave a stale entry for a never-existed file.
  const existingFiles = new Set(
    (await readdir(SAMPLES_DIR)).filter((f) => f.endsWith(".json")).map((f) =>
      f.slice(0, -".json".length),
    ),
  );
  manifest.schemas = manifest.schemas.filter((s) =>
    existingFiles.has(s.descriptive_name),
  );
  await writeManifest(manifest);

  process.stderr.write(`\ndone — ${manifest.schemas.length} schemas in corpus\n`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
