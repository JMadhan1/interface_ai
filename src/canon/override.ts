import type { Capability, LocatorChain, TenantOverride } from "../artifact/schema.js";
import { TENANTS } from "../../mock-app/tenants.js";

/**
 * Cross-tenant reuse (stretch goal). Rather than re-recording a capability
 * per tenant, we detect where the *same underlying vendor product* uses
 * different label copy for the same control across tenants, and generate a
 * minimal override: a locator chain to try first, with the originally
 * recorded chain kept as a fallback. This is what "safely specialized"
 * means here — the base capability still works unmodified against any
 * tenant that didn't rename the control.
 *
 * This is intentionally a small, explainable heuristic (compare known
 * per-tenant label config for the same control), not a generic UI-diffing
 * engine — a human reviewer would author or approve overrides like this in
 * practice; see REPORT.md for how this would scale past two known tenants.
 */
export function generateLabelDriftOverride(capability: Capability, forTenant: string): TenantOverride {
  const baseTenant = TENANTS[capability.provenance.baseTenant];
  const targetTenant = TENANTS[forTenant];
  if (!baseTenant || !targetTenant) {
    throw new Error(`unknown tenant in drift comparison: ${capability.provenance.baseTenant} / ${forTenant}`);
  }

  const locatorOverrides: Record<string, LocatorChain> = {};

  if (baseTenant.openSubAccountButtonLabel !== targetTenant.openSubAccountButtonLabel) {
    for (const step of capability.steps) {
      if (step.action !== "click") continue;
      const primary = step.locators[0];
      if (primary?.kind === "role" && primary.name === baseTenant.openSubAccountButtonLabel) {
        locatorOverrides[step.stepId] = [
          {
            kind: "role",
            role: primary.role,
            name: targetTenant.openSubAccountButtonLabel,
            confidence: 0.9,
            rationale: `Tenant "${forTenant}" labels this control "${targetTenant.openSubAccountButtonLabel}" instead of "${baseTenant.openSubAccountButtonLabel}" — same vendor product, different branding copy.`,
          },
        ];
      }
    }
  }

  return {
    forTenant,
    baseCapabilityId: capability.id,
    baseCapabilityVersion: capability.version,
    reason: `Label drift between base tenant "${capability.provenance.baseTenant}" and "${forTenant}" for the same underlying app.`,
    locatorOverrides,
  };
}
