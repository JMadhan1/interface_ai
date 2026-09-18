import type { ActionStep, Capability, InputParam } from "./schema.js";

export interface ParamSpec extends InputParam {
  literalValue: string;
}

/**
 * A raw discovery transcript records whatever literal values the model
 * happened to use ("12345", "500"). A human curator (or, here, this
 * post-processing pass) identifies which of those literals were actually
 * meant to vary per invocation and rewrites them to `{{paramName}}`
 * template placeholders, registering the corresponding typed input param.
 * This is what turns a one-off recording into a genuinely reusable,
 * parameterized capability.
 */
export function parameterize(capability: Capability, params: ParamSpec[]): Capability {
  const inputParams: InputParam[] = [...capability.inputParams];
  for (const p of params) {
    if (!inputParams.find((ip) => ip.name === p.name)) {
      inputParams.push({ name: p.name, type: p.type, required: p.required, description: p.description, sensitive: p.sensitive ?? false });
    }
  }

  const steps: ActionStep[] = capability.steps.map((step) => {
    let updated: ActionStep = { ...step };
    for (const p of params) {
      if ("value" in updated && typeof (updated as any).value === "string" && (updated as any).value === p.literalValue) {
        updated = { ...updated, value: `{{${p.name}}}` } as ActionStep;
      }
      if ("url" in updated && typeof (updated as any).url === "string" && (updated as any).url.includes(p.literalValue)) {
        updated = { ...updated, url: (updated as any).url.split(p.literalValue).join(`{{${p.name}}}`) } as ActionStep;
      }
    }
    return updated;
  });

  return { ...capability, inputParams, steps };
}
