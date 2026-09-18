import type { TenantConfig } from "./tenants.js";

// Deliberately legacy-flavored rendering: nested <table> layout, no CSS
// framework, no data-testid/class hooks — only <label for> associations and
// visible text, which is exactly what an accessibility-tree-based locator
// strategy has to rely on in the real environment.

export function page(tenant: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${tenant.brandName} — ${title}</title></head>
<body>
<table border="1" cellpadding="6" cellspacing="0" width="100%">
  <tr><td><h1>${tenant.brandName}</h1></td></tr>
</table>
<table border="0" cellpadding="10" cellspacing="0" width="100%">
  <tr><td>${body}</td></tr>
</table>
</body>
</html>`;
}

export function flash(message: string, kind: "error" | "info" = "info"): string {
  return `<table border="1" cellpadding="8"><tr><td><b>${kind === "error" ? "Notice" : "Info"}:</b> ${message}</td></tr></table><br/>`;
}
