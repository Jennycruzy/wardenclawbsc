/**
 * skill:validate — validate every emitted/example signal against signals.schema.json.
 *
 * Dependency-free JSON Schema (Draft 2020-12 subset) validator covering the keywords this
 * schema uses: type, const, enum, required, properties, additionalProperties, items, oneOf,
 * minimum, maximum, and local $ref (#/$defs/...). Fails loudly (exit 1) on any violation.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HERE);
const SCHEMA_PATH = join(SKILL_DIR, "signals.schema.json");
const EXAMPLES_PATH = join(SKILL_DIR, "examples", "example-signals.jsonl");

type Schema = Record<string, any>;
const root: Schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

function resolveRef(ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref: ${ref}`);
  const parts = ref.slice(2).split("/");
  let node: any = root;
  for (const p of parts) node = node[p];
  if (!node) throw new Error(`$ref not found: ${ref}`);
  return node;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === "number") return typeof v === "number";
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return typeOf(v) === t;
}

function validate(value: any, schema: Schema, path: string, errors: string[]): void {
  if (schema.$ref) {
    validate(value, resolveRef(schema.$ref), path, errors);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e: unknown) => e === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
  }
  if (schema.type === "object" || schema.properties || schema.required) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required property '${req}'`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: additional property '${k}' not allowed`);
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub: Schema) => {
      const e: string[] = [];
      validate(value, sub, path, e);
      return e.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: matched ${matches.length} of oneOf branches (expected exactly 1)`);
    }
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub: Schema) => {
      const e: string[] = [];
      validate(value, sub, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matched none of anyOf branches`);
  }
}

function main(): void {
  if (!existsSync(EXAMPLES_PATH)) {
    console.error(`✗ No example signals at ${EXAMPLES_PATH}. Run 'pnpm skill:backtest' first.`);
    process.exit(1);
  }
  const lines = readFileSync(EXAMPLES_PATH, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    console.error("✗ example-signals.jsonl is empty.");
    process.exit(1);
  }
  let failures = 0;
  const kinds = new Set<string>();
  lines.forEach((line, i) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      console.error(`✗ line ${i + 1}: invalid JSON`);
      failures++;
      return;
    }
    kinds.add(obj.kind);
    const errors: string[] = [];
    validate(obj, root, `signal[${i + 1}]`, errors);
    if (errors.length > 0) {
      failures++;
      console.error(`✗ line ${i + 1} (kind=${obj.kind}):`);
      for (const e of errors) console.error(`    ${e}`);
    }
  });

  const expectedKinds = ["regime_state", "week_state", "entry_candidate", "sizing", "exit_instruction"];
  const missing = expectedKinds.filter((k) => !kinds.has(k));

  if (failures > 0) {
    console.error(`\n✗ ${failures}/${lines.length} signals failed schema validation.`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`\n✗ examples are missing signal kinds: ${missing.join(", ")} (every kind must be exercised).`);
    process.exit(1);
  }
  console.log(`✓ All ${lines.length} signals valid against signals.schema.json.`);
  console.log(`✓ All five signal kinds present: ${expectedKinds.join(", ")}.`);
}

main();
