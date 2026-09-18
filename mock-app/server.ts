import express from "express";
import { nanoid } from "nanoid";
import { TENANTS, type TenantConfig, type Member } from "./tenants.js";
import { page, flash } from "./render.js";

const PORT = Number(process.env.MOCK_APP_PORT ?? 4100);
const SESSION_TTL_MS = process.env.SESSION_TTL_MS ? Number(process.env.SESSION_TTL_MS) : 20 * 60 * 1000; // 20 minutes, wall-clock realistic (override for testing)
const CONFIRMATION_THRESHOLD = 10000;

interface Session {
  tenant: string;
  username: string;
  lastActivity: number;
}

const sessions = new Map<string, Session>();
const flakyAttempts = new Map<string, number>(); // key: tenant/memberId
const serverErrorArmed = new Set<string>(); // key: tenant

const app = express();
app.use(express.urlencoded({ extended: true }));

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function tenantConfig(slug: string): TenantConfig {
  const t = TENANTS[slug];
  if (!t) throw new Error(`unknown tenant ${slug}`);
  return t;
}

function requireSession(req: express.Request, res: express.Response, tenant: string): Session | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies["session"];
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.tenant !== tenant || Date.now() - session.lastActivity > SESSION_TTL_MS) {
    if (session) sessions.delete(token!);
    res.status(401).send(
      page(tenantConfig(tenant), "Session Expired", flash("Your session has expired. Please log in again.", "error") +
        `<a href="/${tenant}/login">Return to login</a>`)
    );
    return null;
  }
  session.lastActivity = Date.now();
  return session;
}

// ---- login ----

app.get("/:tenant/login", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  res.send(
    page(
      t,
      "Operator Login",
      `<form method="post" action="/${t.slug}/login">
        <table cellpadding="6">
          <tr><td><label for="username">Username</label></td><td><input id="username" name="username" type="text"/></td></tr>
          <tr><td><label for="password">Password</label></td><td><input id="password" name="password" type="password"/></td></tr>
          <tr><td colspan="2"><button type="submit">Log In</button></td></tr>
        </table>
      </form>`
    )
  );
});

app.post("/:tenant/login", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  const { username, password } = req.body ?? {};
  if (username !== "operator" || password !== "operator123") {
    res.status(401).send(
      page(t, "Operator Login", flash("Invalid username or password.", "error") +
        `<form method="post" action="/${t.slug}/login">
          <table cellpadding="6">
            <tr><td><label for="username">Username</label></td><td><input id="username" name="username" type="text"/></td></tr>
            <tr><td><label for="password">Password</label></td><td><input id="password" name="password" type="password"/></td></tr>
            <tr><td colspan="2"><button type="submit">Log In</button></td></tr>
          </table>
        </form>`)
    );
    return;
  }
  const token = nanoid();
  sessions.set(token, { tenant: t.slug, username, lastActivity: Date.now() });
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly`);
  res.redirect(`/${t.slug}/search`);
});

// ---- search ----

app.get("/:tenant/search", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  if (!requireSession(req, res, t.slug)) return;
  res.send(
    page(
      t,
      `${t.entityLabel} Lookup`,
      `<form method="post" action="/${t.slug}/search">
        <table cellpadding="6">
          <tr><td><label for="memberId">${t.entityLabel} ID</label></td><td><input id="memberId" name="memberId" type="text"/></td></tr>
          <tr><td colspan="2"><button type="submit">Look Up ${t.entityLabel}</button></td></tr>
        </table>
      </form>`
    )
  );
});

app.post("/:tenant/search", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  if (!requireSession(req, res, t.slug)) return;
  const memberId = String(req.body?.memberId ?? "").trim();
  res.redirect(`/${t.slug}/members/${encodeURIComponent(memberId)}`);
});

// ---- member detail ----

app.get("/:tenant/members/:id", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  if (!requireSession(req, res, t.slug)) return;
  const id = req.params.id;
  const key = `${t.slug}/${id}`;

  if (serverErrorArmed.has(t.slug)) {
    serverErrorArmed.delete(t.slug);
    res.status(500).send("Internal Server Error — unexpected condition in servicing module");
    return;
  }

  if (id === "88888") {
    const attempts = (flakyAttempts.get(key) ?? 0) + 1;
    flakyAttempts.set(key, attempts);
    if (attempts % 3 === 1) {
      res.status(503).send(
        page(t, "Temporarily Unavailable", flash("System temporarily unavailable. Please retry.", "error"))
      );
      return;
    }
  }

  const member: Member | undefined = t.members[id];

  if (id === "77777") {
    res.status(403).send(
      page(t, "Access Denied", flash(`You do not have permission to view ${t.entityLabel.toLowerCase()} ${id}.`, "error"))
    );
    return;
  }

  if (!member) {
    res.status(200).send(
      page(t, `${t.entityLabel} Lookup`, flash(`No ${t.entityLabel.toLowerCase()} found with ID ${id}.`, "error") +
        `<a href="/${t.slug}/search">Search again</a>`)
    );
    return;
  }

  const branchRow = t.showBranchColumn ? `<tr><td><b>Branch Code</b></td><td>0417</td></tr>` : "";
  const subAccountRows = member.subAccounts
    .map((sa) => `<tr><td>${sa.id}</td><td>${sa.type}</td><td>$${sa.balance.toFixed(2)}</td></tr>`)
    .join("");

  res.send(
    page(
      t,
      `${t.entityLabel} ${member.id}`,
      `<table border="1" cellpadding="6">
        <tr><td><b>Name</b></td><td>${member.name}</td></tr>
        <tr><td><b>Savings Balance</b></td><td>$${member.savingsBalance.toFixed(2)}</td></tr>
        <tr><td><b>Checking Balance</b></td><td>$${member.checkingBalance.toFixed(2)}</td></tr>
        ${branchRow}
      </table>
      <br/>
      <table border="1" cellpadding="6">
        <tr><th>Sub-Account ID</th><th>Type</th><th>Balance</th></tr>
        ${subAccountRows}
      </table>
      <br/>
      <a href="/${t.slug}/members/${member.id}/sub-accounts/new"><button type="button">${t.openSubAccountButtonLabel}</button></a>`
    )
  );
});

// ---- open sub-account ----

function subAccountForm(t: TenantConfig, id: string, opts?: { deposit?: string; type?: string; error?: string }) {
  return page(
    t,
    `New Sub-Account for ${t.entityLabel} ${id}`,
    (opts?.error ? flash(opts.error, "error") : "") +
      `<form method="post" action="/${t.slug}/members/${id}/sub-accounts">
        <table cellpadding="6">
          <tr><td><label for="type">Account Type</label></td>
          <td><select id="type" name="type">
            <option value="Holiday Club" ${opts?.type === "Holiday Club" ? "selected" : ""}>Holiday Club</option>
            <option value="Vacation Fund" ${opts?.type === "Vacation Fund" ? "selected" : ""}>Vacation Fund</option>
            <option value="Emergency Fund" ${opts?.type === "Emergency Fund" ? "selected" : ""}>Emergency Fund</option>
          </select></td></tr>
          <tr><td><label for="deposit">Initial Deposit</label></td>
          <td><input id="deposit" name="deposit" type="text" value="${opts?.deposit ?? ""}"/></td></tr>
          <tr><td colspan="2"><button type="submit">Submit</button></td></tr>
        </table>
      </form>`
  );
}

app.get("/:tenant/members/:id/sub-accounts/new", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  if (!requireSession(req, res, t.slug)) return;
  res.send(subAccountForm(t, req.params.id));
});

app.post("/:tenant/members/:id/sub-accounts", (req, res) => {
  const t = tenantConfig(req.params.tenant);
  if (!requireSession(req, res, t.slug)) return;
  const id = req.params.id;
  const { type, deposit, confirmed } = req.body ?? {};
  const amount = Number(deposit);

  if (!type || !Number.isFinite(amount) || amount < 25) {
    res.status(200).send(
      subAccountForm(t, id, {
        deposit,
        type,
        error: "Initial deposit must be a number of at least $25.",
      })
    );
    return;
  }

  if (amount > CONFIRMATION_THRESHOLD && confirmed !== "true") {
    res.send(
      page(
        t,
        "Confirm Large Deposit",
        flash(
          `This deposit ($${amount.toFixed(2)}) exceeds the standard threshold of $${CONFIRMATION_THRESHOLD.toLocaleString()}. Please confirm to proceed.`,
          "error"
        ) +
          `<form method="post" action="/${t.slug}/members/${id}/sub-accounts">
            <input type="hidden" name="type" value="${type}"/>
            <input type="hidden" name="deposit" value="${amount}"/>
            <input type="hidden" name="confirmed" value="true"/>
            <button type="submit">Confirm</button>
          </form>
          <a href="/${t.slug}/members/${id}">Cancel</a>`
      )
    );
    return;
  }

  const member = t.members[id];
  if (!member) {
    res.status(200).send(flash(`No ${t.entityLabel.toLowerCase()} found with ID ${id}.`, "error"));
    return;
  }
  const accountId = `SA-${nanoid(6).toUpperCase()}`;
  member.subAccounts.push({ id: accountId, type, balance: amount });

  res.send(
    page(
      t,
      "Sub-Account Created",
      `<table border="1" cellpadding="6">
        <tr><td><b>Status</b></td><td>Sub-account created successfully</td></tr>
        <tr><td><b>New Account ID</b></td><td>${accountId}</td></tr>
        <tr><td><b>Type</b></td><td>${type}</td></tr>
        <tr><td><b>Initial Deposit</b></td><td>$${amount.toFixed(2)}</td></tr>
      </table>`
    )
  );
});

// ---- dev-only fault injection (for deterministic evidence generation) ----

app.post("/:tenant/dev/simulate/expire-session", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies["session"];
  let session = token ? sessions.get(token) : undefined;
  if (!session) {
    // Test convenience: no cookie presented (e.g. an out-of-band test
    // harness expiring the session an in-progress automation run is using,
    // without knowing its token) — expire the most recently active session
    // for this tenant instead. Dev-only, namespaced under /dev/.
    let mostRecent: Session | undefined;
    for (const s of sessions.values()) {
      if (s.tenant === req.params.tenant && (!mostRecent || s.lastActivity > mostRecent.lastActivity)) mostRecent = s;
    }
    session = mostRecent;
  }
  if (session) session.lastActivity = 0;
  res.status(204).end();
});

app.post("/:tenant/dev/simulate/server-error", (req, res) => {
  serverErrorArmed.add(req.params.tenant);
  res.status(204).end();
});

app.get("/", (_req, res) => {
  res.send(
    `<p>Mock legacy back-office. Tenants: ${Object.keys(TENANTS)
      .map((s) => `<a href="/${s}/login">${s}</a>`)
      .join(" | ")}</p>`
  );
});

app.listen(PORT, () => {
  console.log(`[mock-app] listening on http://localhost:${PORT}`);
  console.log(`[mock-app] tenants: ${Object.keys(TENANTS).join(", ")}`);
  console.log(`[mock-app] login: operator / operator123`);
});
