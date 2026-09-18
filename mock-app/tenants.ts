// Two tenants running the "same vendor product" (this mock app) with different
// branding, terminology, and a minor layout/label drift. Used to demonstrate
// cross-tenant artifact reuse in the capability replay engine.

export interface Member {
  id: string;
  name: string;
  savingsBalance: number;
  checkingBalance: number;
  subAccounts: { id: string; type: string; balance: number }[];
}

export interface TenantConfig {
  slug: string;
  brandName: string;
  entityLabel: string; // "Member" vs "Customer"
  openSubAccountButtonLabel: string; // deliberately differs across tenants
  showBranchColumn: boolean; // schema drift: an extra column on tenant-b
  members: Record<string, Member>;
}

function baseMembers(): Record<string, Member> {
  return {
    "12345": {
      id: "12345",
      name: "Jordan Ellis",
      savingsBalance: 4820.55,
      checkingBalance: 1200.1,
      subAccounts: [{ id: "SA-1001", type: "Holiday Club", balance: 300 }],
    },
    "77777": {
      id: "77777",
      name: "Restricted Record",
      savingsBalance: 0,
      checkingBalance: 0,
      subAccounts: [],
    },
    "88888": {
      id: "88888",
      name: "Flaky Load Member",
      savingsBalance: 990.25,
      checkingBalance: 410.0,
      subAccounts: [],
    },
  };
}

export const TENANTS: Record<string, TenantConfig> = {
  "tenant-a": {
    slug: "tenant-a",
    brandName: "Meridian Credit Union — Teller Console",
    entityLabel: "Member",
    openSubAccountButtonLabel: "Open Sub-Account",
    showBranchColumn: false,
    members: baseMembers(),
  },
  "tenant-b": {
    slug: "tenant-b",
    brandName: "Harborline Financial — Servicing Desk",
    entityLabel: "Customer",
    openSubAccountButtonLabel: "Create New Sub-Account",
    showBranchColumn: true,
    members: (() => {
      const m = baseMembers();
      const base = m["12345"]!;
      m["12345"] = { ...base, name: "Dana Whitfield", savingsBalance: 3110.4 };
      return m;
    })(),
  },
};
