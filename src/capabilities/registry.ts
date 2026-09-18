import { listCapabilities, loadTenantOverride } from "../artifact/store.js";
import { replayCapability, type ReplayResult } from "../replay/executor.js";
import { launchSurface } from "../surface/browser.js";
import { DEFAULT_ALLOWLIST } from "../safety/allowlist.js";
import type { Capability } from "../artifact/schema.js";

// ---------------------------------------------------------------------------
// Agent-facing capability interface (stretch goal). This is the surface an
// AI agent (interface.ai's own product, in the real system) would use: list
// what capabilities exist with their typed contracts, then invoke one by
// name with typed args. It is a thin wrapper over the same deterministic
// replay engine replay uses directly — there is no separate "agent path,"
// which is the point: whatever the CLI can replay, an agent can invoke.
// ---------------------------------------------------------------------------

export interface CapabilityDescriptor {
  id: string;
  name: string;
  description: string;
  version: number;
  inputParams: Capability["inputParams"];
  outputs: Capability["outputs"];
}

export function listCapabilityCatalog(): CapabilityDescriptor[] {
  return listCapabilities().map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    version: c.version,
    inputParams: c.inputParams,
    outputs: c.outputs,
  }));
}

export class CapabilityNotFoundError extends Error {}
export class MissingParamError extends Error {}

export async function invokeCapability(opts: {
  capabilityIdOrName: string;
  args: Record<string, string | number | boolean>;
  forTenant?: string;
  evidenceDir?: string;
}): Promise<ReplayResult> {
  const all = listCapabilities();
  const cap = all.find((c) => c.id === opts.capabilityIdOrName || c.name === opts.capabilityIdOrName);
  if (!cap) throw new CapabilityNotFoundError(`capability not found: ${opts.capabilityIdOrName}`);

  const effectiveArgs: Record<string, string | number | boolean> = {
    baseTenant: opts.forTenant ?? cap.provenance.baseTenant,
    ...opts.args,
  };

  for (const p of cap.inputParams) {
    if (p.required && !(p.name in effectiveArgs)) {
      throw new MissingParamError(`missing required param: ${p.name} (${p.description})`);
    }
  }

  const override = opts.forTenant && opts.forTenant !== cap.provenance.baseTenant ? (loadTenantOverride(cap.id, opts.forTenant) ?? undefined) : undefined;

  const { page, close } = await launchSurface();
  try {
    return await replayCapability({
      page,
      capability: cap,
      params: effectiveArgs,
      allowlist: DEFAULT_ALLOWLIST,
      evidenceDir: opts.evidenceDir ?? "evidence/invocations",
      tenantOverride: override,
      riskyStepPolicy: "auto",
      autoResumeEscalations: true,
    });
  } finally {
    await close();
  }
}
