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

  // Second, distinct drift with the same root cause: any control's visible
  // copy — a field label OR a button's accessible name — can be templated
  // off the tenant's terminology ("Member" vs "Customer"), not just the one
  // button already handled above. Caught incrementally in practice: the
  // first version of this function covered only the "Open Sub-Account"
  // button; replaying against tenant-b then hard-failed at the "Member ID"
  // field (a `label` locator), and after fixing that, hard-failed *again*
  // at the "Look Up Member" search button (a `role` locator) — both are the
  // same underlying drift, so this checks every locator kind that carries
  // text, once, rather than accumulating more one-off cases.
  if (baseTenant.entityLabel !== targetTenant.entityLabel) {
    const wordBoundary = new RegExp(`\\b${baseTenant.entityLabel}\\b`);
    for (const step of capability.steps) {
      if (!("locators" in step) || locatorOverrides[step.stepId]) continue;
      const primary = step.locators[0];
      if (primary?.kind === "label" && wordBoundary.test(primary.label)) {
        locatorOverrides[step.stepId] = [
          {
            kind: "label",
            label: primary.label.replace(wordBoundary, targetTenant.entityLabel),
            confidence: 0.9,
            rationale: `Tenant "${forTenant}" calls this entity "${targetTenant.entityLabel}" instead of "${baseTenant.entityLabel}" — the field label is templated off that terminology.`,
          },
        ];
      } else if (primary?.kind === "role" && wordBoundary.test(primary.name)) {
        locatorOverrides[step.stepId] = [
          {
            kind: "role",
            role: primary.role,
            name: primary.name.replace(wordBoundary, targetTenant.entityLabel),
            confidence: 0.9,
            rationale: `Tenant "${forTenant}" calls this entity "${targetTenant.entityLabel}" instead of "${baseTenant.entityLabel}" — this control's accessible name is templated off that terminology.`,
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
