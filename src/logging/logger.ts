import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactDeep } from "../safety/redact.js";

export type LogEvent = {
  ts: string;
  runId: string;
  level: "info" | "warn" | "error";
  event: string;
  [key: string]: unknown;
};

/**
 * Structured JSON-lines logger. Every record is redacted before it is
 * written or echoed to stdout — logs are exactly the kind of place
 * regulated financial data quietly leaks if you're not deliberate about it.
 */
export class RunLogger {
  private filePath: string;
  private runId: string;

  constructor(filePath: string, runId: string) {
    this.filePath = filePath;
    this.runId = runId;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  log(level: LogEvent["level"], event: string, data: Record<string, unknown> = {}): void {
    const record: LogEvent = redactDeep({
      ts: new Date().toISOString(),
      runId: this.runId,
      level,
      event,
      ...data,
    });
    const line = JSON.stringify(record);
    appendFileSync(this.filePath, line + "\n", "utf-8");
    const prefix = level === "error" ? "[error]" : level === "warn" ? "[warn]" : "[info]";
    console.log(`${prefix} ${event}`, Object.keys(data).length ? redactDeep(data) : "");
  }

  info(event: string, data?: Record<string, unknown>) {
    this.log("info", event, data);
  }
  warn(event: string, data?: Record<string, unknown>) {
    this.log("warn", event, data);
  }
  error(event: string, data?: Record<string, unknown>) {
    this.log("error", event, data);
  }
}
