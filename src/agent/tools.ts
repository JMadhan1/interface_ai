// The agent's action vocabulary is semantic, not raw DOM/CSS. This is a
// deliberate design choice: the model expresses *intent* ("fill the field
// labeled X"), and src/surface/act.ts is solely responsible for turning that
// into a robust locator chain. Keeping selector-authorship out of the
// model's hands is what keeps the resulting artifact reviewable and
// replayable instead of full of one-off brittle CSS the LLM happened to
// guess.

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the browser to an absolute URL within the allowed origin.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an interactive element identified by its accessibility role and accessible name, e.g. role='button', name='Submit'.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "ARIA role, e.g. button, link" },
          name: { type: "string", description: "Accessible name / visible label of the element" },
          intent: { type: "string", description: "Why you're clicking this, in one short sentence" },
        },
        required: ["role", "name", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill",
      description: "Type a value into a form field identified by its <label> text.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          intent: { type: "string" },
          sensitive: { type: "boolean", description: "true if this value is a secret/credential (never a business ID or amount)" },
        },
        required: ["label", "value", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description: "Choose an option in a <select> dropdown identified by its <label> text.",
      parameters: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" }, intent: { type: "string" } },
        required: ["label", "value", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_text",
      description: "Wait until specific text becomes visible on the page (use after an action that triggers navigation or an async update).",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, intent: { type: "string" } },
        required: ["text", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_labeled_value",
      description: "Read a value shown next to a label on the page (e.g. a balance field) and store it under outputKey for the final result.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          outputKey: { type: "string" },
          as: { type: "string", enum: ["text", "number"] },
          intent: { type: "string" },
        },
        required: ["label", "outputKey", "as", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call this once the goal has been fully achieved. Declares the checkpoint text that proves success and the final outputs.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          successCheckpointText: { type: "string", description: "Exact or near-exact text visible on the page that proves the goal was reached" },
          outputs: { type: "object", description: "Map of outputKey -> value, from prior extract_labeled_value calls" },
        },
        required: ["summary", "successCheckpointText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human",
      description: "Call this if you cannot safely proceed (ambiguous UI, unexpected/unrecognized state, an action outside your permitted scope, or repeated failures). Explain why.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
] as const;
