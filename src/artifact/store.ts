import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilitySchema, TenantOverrideSchema, type Capability, type TenantOverride } from "./schema.js";
import { redactDeep } from "../safety/redact.js";

const ARTIFACTS_DIR = "artifacts";
const OVERRIDES_DIR = join(ARTIFACTS_DIR, "overrides");

export function saveCapability(capability: Capability): string {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Validate before persisting — an artifact that doesn't conform to the
  // contract must never reach disk, since replay trusts it implicitly.
  const parsed = CapabilitySchema.parse(capability);
  const redacted = redactDeep(parsed); // defense in depth; steps should carry no raw secrets already
  const path = join(ARTIFACTS_DIR, `${redacted.id}.v${redacted.version}.json`);
  writeFileSync(path, JSON.stringify(redacted, null, 2), "utf-8");
  return path;
}

export function loadCapability(idOrPath: string): Capability {
  const path = idOrPath.endsWith(".json") ? idOrPath : findLatestVersionPath(idOrPath);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return CapabilitySchema.parse(raw);
}

function findLatestVersionPath(id: string): string {
  if (!existsSync(ARTIFACTS_DIR)) throw new Error(`no artifacts directory found`);
  const matches = readdirSync(ARTIFACTS_DIR).filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".json"));
  if (matches.length === 0) throw new Error(`no artifact found for id ${id}`);
  matches.sort((a, b) => {
    const va = Number(a.match(/\.v(\d+)\.json$/)?.[1] ?? 0);
    const vb = Number(b.match(/\.v(\d+)\.json$/)?.[1] ?? 0);
    return vb - va;
  });
  return join(ARTIFACTS_DIR, matches[0]!);
}

export function listCapabilities(): Capability[] {
  if (!existsSync(ARTIFACTS_DIR)) return [];
  return readdirSync(ARTIFACTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => CapabilitySchema.parse(JSON.parse(readFileSync(join(ARTIFACTS_DIR, f), "utf-8"))));
}

export function saveTenantOverride(override: TenantOverride): string {
  mkdirSync(OVERRIDES_DIR, { recursive: true });
  const parsed = TenantOverrideSchema.parse(override);
  const path = join(OVERRIDES_DIR, `${parsed.baseCapabilityId}.${parsed.forTenant}.json`);
  writeFileSync(path, JSON.stringify(parsed, null, 2), "utf-8");
  return path;
}

export function loadTenantOverride(capabilityId: string, forTenant: string): TenantOverride | null {
  const path = join(OVERRIDES_DIR, `${capabilityId}.${forTenant}.json`);
  if (!existsSync(path)) return null;
  return TenantOverrideSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}
