#!/usr/bin/env bun
/**
 * Shape validator for canonical-samples.
 *
 * Given a samples/ directory, asserts every `<descriptive_name>.json`
 * conforms to the canonical schema's `field_types` in the live
 * schema_service snapshot. Type-only — not a semantic validator.
 *
 * Usage:
 *   bun validate.ts <samples-dir>          # validate every *.json
 *   bun validate.ts <samples-dir> Message  # validate one schema
 *
 * Env:
 *   EXEMEM_DEV_API_KEY  — required, used to fetch the snapshot
 *   SCHEMA_SERVICE_URL  — optional override, defaults to the
 *                         production schema_service-dev API Gateway
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";

const DEFAULT_SCHEMA_SERVICE_URL =
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";

export type FieldType =
  | "String"
  | "Boolean"
  | "Float"
  | "Integer"
  | "Any"
  | "Null"
  | { Array: FieldType }
  | { OneOf: FieldType[] };

export interface CanonicalSchema {
  descriptive_name: string;
  identity_hash: string;
  field_types: Record<string, FieldType>;
  field_descriptions?: Record<string, string>;
}

export interface SnapshotEnvelope {
  schemas: CanonicalSchema[];
  captured_at?: string;
}

export async function fetchSnapshot(
  url: string,
  apiKey: string,
): Promise<SnapshotEnvelope> {
  const r = await fetch(`${url}/v1/snapshot`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!r.ok) {
    throw new Error(
      `snapshot fetch failed: HTTP ${r.status} — ${await r.text()}`,
    );
  }
  return (await r.json()) as SnapshotEnvelope;
}

export function indexByDescriptiveName(
  snap: SnapshotEnvelope,
): Map<string, CanonicalSchema> {
  // When multiple schemas share a descriptive_name, prefer the one with
  // the highest field count (most-detailed canonical instance). This
  // matches the curation heuristic the generator uses on selection.
  const out = new Map<string, CanonicalSchema>();
  for (const s of snap.schemas) {
    if (!s.descriptive_name || !s.field_types) continue;
    const existing = out.get(s.descriptive_name);
    if (
      !existing ||
      Object.keys(s.field_types).length >
        Object.keys(existing.field_types).length
    ) {
      out.set(s.descriptive_name, s);
    }
  }
  return out;
}

export function valueMatchesType(value: unknown, t: FieldType): boolean {
  if (t === "Any") return true;
  if (t === "Null") return value === null;
  if (t === "String") return typeof value === "string";
  if (t === "Boolean") return typeof value === "boolean";
  if (t === "Float") return typeof value === "number" && Number.isFinite(value);
  if (t === "Integer")
    return typeof value === "number" && Number.isInteger(value);
  if (typeof t === "object" && t !== null) {
    if ("Array" in t) {
      if (!Array.isArray(value)) return false;
      const inner = t.Array;
      return value.every((v) => valueMatchesType(v, inner));
    }
    if ("OneOf" in t) {
      return t.OneOf.some((opt) => valueMatchesType(value, opt));
    }
  }
  return false;
}

export interface RowError {
  rowIndex: number;
  reason: string;
}

export function validateRow(
  row: unknown,
  fieldTypes: Record<string, FieldType>,
): string | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return "row is not a plain object";
  }
  const declared = new Set(Object.keys(fieldTypes));
  const actual = new Set(Object.keys(row as object));
  for (const k of actual) {
    if (!declared.has(k)) {
      return `unexpected field "${k}" (not in field_types)`;
    }
  }
  for (const [field, type] of Object.entries(fieldTypes)) {
    if (!(field in (row as object))) {
      return `missing field "${field}"`;
    }
    const v = (row as Record<string, unknown>)[field];
    if (!valueMatchesType(v, type)) {
      return `field "${field}" has wrong type for declared ${JSON.stringify(
        type,
      )}: got ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export interface SchemaValidationResult {
  file: string;
  descriptive_name: string;
  identity_hash_expected?: string;
  identity_hash_current: string;
  total: number;
  passed: number;
  errors: RowError[];
}

export async function validateFile(
  filePath: string,
  schemasByName: Map<string, CanonicalSchema>,
  manifestEntry?: { identity_hash?: string },
): Promise<SchemaValidationResult> {
  const name = basename(filePath, ".json");
  const schema = schemasByName.get(name);
  if (!schema) {
    throw new Error(
      `${filePath}: no canonical schema named "${name}" in current snapshot`,
    );
  }
  const raw = await readFile(filePath, "utf8");
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${filePath}: invalid JSON — ${(e as Error).message}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error(`${filePath}: top-level must be a JSON array, got ${typeof rows}`);
  }
  const errors: RowError[] = [];
  for (let i = 0; i < rows.length; i++) {
    const reason = validateRow(rows[i], schema.field_types);
    if (reason) errors.push({ rowIndex: i, reason });
  }
  return {
    file: filePath,
    descriptive_name: name,
    identity_hash_expected: manifestEntry?.identity_hash,
    identity_hash_current: schema.identity_hash,
    total: rows.length,
    passed: rows.length - errors.length,
    errors,
  };
}

async function loadManifest(
  samplesDir: string,
): Promise<{
  schemas?: Array<{ descriptive_name: string; identity_hash: string }>;
}> {
  // manifest.json lives one level up from samples/
  const path = resolve(samplesDir, "..", "manifest.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    console.error("usage: bun validate.ts <samples-dir> [schemaName]");
    process.exit(2);
  }
  const samplesDir = resolve(argv[0]);
  const onlyName = argv[1];

  const apiKey = process.env.EXEMEM_DEV_API_KEY;
  if (!apiKey) {
    console.error(
      "EXEMEM_DEV_API_KEY is required to fetch the schema_service snapshot",
    );
    process.exit(2);
  }
  const url = process.env.SCHEMA_SERVICE_URL ?? DEFAULT_SCHEMA_SERVICE_URL;

  process.stderr.write(`fetching snapshot from ${url}/v1/snapshot ... `);
  const snap = await fetchSnapshot(url, apiKey);
  process.stderr.write(`${snap.schemas.length} schemas\n`);
  const byName = indexByDescriptiveName(snap);

  const manifest = await loadManifest(samplesDir);
  const manifestByName = new Map(
    (manifest.schemas ?? []).map((s) => [s.descriptive_name, s]),
  );

  const files = (await readdir(samplesDir))
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !onlyName || basename(f, ".json") === onlyName)
    .map((f) => resolve(samplesDir, f));

  if (files.length === 0) {
    console.error(`no *.json files in ${samplesDir}`);
    process.exit(2);
  }

  let failures = 0;
  let hashDrift = 0;
  for (const f of files) {
    let res: SchemaValidationResult;
    try {
      res = await validateFile(f, byName, manifestByName.get(basename(f, ".json")));
    } catch (e) {
      console.error(`FAIL ${f}: ${(e as Error).message}`);
      failures++;
      continue;
    }
    const drifted =
      res.identity_hash_expected &&
      res.identity_hash_expected !== res.identity_hash_current;
    const tag = res.errors.length === 0 ? "OK" : "FAIL";
    const drift = drifted ? " (hash drift)" : "";
    console.log(
      `${tag} ${basename(f)}: ${res.passed}/${res.total} rows${drift}`,
    );
    if (drifted) hashDrift++;
    for (const e of res.errors.slice(0, 5)) {
      console.error(`    row ${e.rowIndex}: ${e.reason}`);
    }
    if (res.errors.length > 5) {
      console.error(`    ... ${res.errors.length - 5} more`);
    }
    if (res.errors.length > 0) failures++;
  }

  if (hashDrift > 0) {
    console.error(
      `\n${hashDrift} file(s) generated against an identity_hash that has since drifted — regenerate them`,
    );
  }
  if (failures > 0) {
    console.error(`\n${failures} file(s) failed shape validation`);
    process.exit(1);
  }
  console.log(`\nall ${files.length} file(s) passed shape validation`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
