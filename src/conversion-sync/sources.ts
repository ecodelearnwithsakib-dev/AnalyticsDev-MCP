import { optionalEnv } from "../shared/env.js";
import { callTool, configured } from "../shared/hub.js";

/** A won deal / closed opportunity with everything ad platforms can match on. */
export type Deal = {
  source: string;
  id: string;
  name: string;
  value: number;
  currency: string;
  won_at: string;
  email?: string;
  phone?: string;
  contact_id?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  msclkid?: string;
  fbclid?: string;
  fbc?: string;
  rdt_cid?: string;
  oppref?: string;
};

type Rec = Record<string, unknown>;
const rowsOf = (r: unknown): Rec[] => (Array.isArray(r) ? (r as Rec[]) : (((r as Rec)?.records ?? (r as Rec)?.rows ?? (r as Rec)?.deals ?? (r as Rec)?.opportunities ?? (r as Rec)?.data ?? []) as Rec[]));
const defaultCurrency = () => optionalEnv("CONVSYNC_CURRENCY", "USD").toUpperCase();

/** Finds click IDs in any record by key/label (gclid, gbraid, wbraid, msclkid, fbclid/_fbc, rdt_cid, oppref). */
export function clickIds(...records: (Rec | undefined)[]): Partial<Deal> {
  const out: Partial<Deal> = {};
  const visit = (k: string, v: unknown) => {
    if (typeof v !== "string" || !v) return;
    const key = k.toLowerCase().replace(/[^a-z_]/g, "");
    if (/gclid/.test(key)) out.gclid ??= v;
    else if (/gbraid/.test(key)) out.gbraid ??= v;
    else if (/wbraid/.test(key)) out.wbraid ??= v;
    else if (/msclkid/.test(key)) out.msclkid ??= v;
    else if (/fbclid/.test(key)) out.fbclid ??= v;
    else if (/^_?fbc$|fbc_cookie|fb_click/.test(key)) out.fbc ??= v;
    else if (/rdt_?cid|redditclick/.test(key)) out.rdt_cid ??= v;
    else if (/oppref/.test(key)) out.oppref ??= v;
  };
  const walk = (o: unknown, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o as Rec)) {
      if (v && typeof v === "object") walk(v, depth + 1);
      else visit(k, v);
      // custom fields shaped { name/label, value }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = v as Rec;
        const label = (r.name ?? r.label ?? r.fieldKey ?? r.api_name) as string | undefined;
        if (label) visit(label, r.value ?? r.field_value);
      }
    }
  };
  for (const r of records) walk(r);
  if (!out.fbc && out.fbclid) out.fbc = `fb.1.${Date.now()}.${out.fbclid}`;
  return out;
}

export type Window = { from: string; to: string };
const inWindow = (iso: string | undefined, w: Window) => !!iso && iso.slice(0, 10) >= w.from && iso.slice(0, 10) <= w.to;

type Source = { key: string; title: string; isConfigured: () => boolean; fetch: (w: Window) => Promise<Deal[]> };

const pipedrive: Source = {
  key: "pipedrive",
  title: "Pipedrive (won deals)",
  isConfigured: () => configured("PIPEDRIVE_API_TOKEN", "PIPEDRIVE_DOMAIN"),
  async fetch(w) {
    const res = await callTool<{ deals?: Rec[] }>("pipedrive", "pipedrive_deals", { action: "list", status: "won", updated_since: w.from, limit: 2000 });
    const deals = (res.deals ?? []).filter((d) => inWindow(String(d.won ?? ""), w));
    const out: Deal[] = [];
    for (const d of deals) {
      const person = d.person_id ? await callTool<Rec>("pipedrive", "pipedrive_contacts", { action: "get", kind: "person", id: Number(d.person_id) }).catch(() => undefined) : undefined;
      out.push({
        source: "pipedrive",
        id: String(d.id),
        name: String(d.title),
        value: Number(d.value ?? 0),
        currency: String(d.currency ?? defaultCurrency()),
        won_at: new Date(String(d.won).replace(" ", "T") + (String(d.won).includes("Z") ? "" : "Z")).toISOString(),
        email: (person?.emails as string[] | undefined)?.[0],
        phone: (person?.phones as string[] | undefined)?.[0],
        contact_id: d.person_id ? `pipedrive-person-${d.person_id}` : undefined,
        ...clickIds(d.custom as Rec, person?.custom as Rec),
      });
    }
    return out;
  },
};

const salesforce: Source = {
  key: "salesforce",
  title: "Salesforce (closed-won opportunities)",
  isConfigured: () => configured("SF_CLIENT_ID") && (configured("SF_REFRESH_TOKEN") || configured("SF_CLIENT_SECRET")),
  async fetch(w) {
    const extra = optionalEnv("CONVSYNC_SF_FIELDS").split(",").map((f) => f.trim()).filter(Boolean);
    const soql = `SELECT Id, Name, Amount, CloseDate, LastModifiedDate${extra.map((f) => `, ${f}`).join("")}, (SELECT Contact.Id, Contact.Email, Contact.Phone FROM OpportunityContactRoles ORDER BY IsPrimary DESC LIMIT 1) FROM Opportunity WHERE IsWon = true AND CloseDate >= ${w.from} AND CloseDate <= ${w.to} ORDER BY CloseDate`;
    const res = await callTool<{ records?: Rec[] }>("salesforce", "sf_query", { soql, max_rows: 5000 });
    return (res.records ?? []).map((o) => {
      const role = ((o.OpportunityContactRoles as Rec[] | undefined) ?? [])[0] ?? {};
      return {
        source: "salesforce",
        id: String(o.Id),
        name: String(o.Name),
        value: Number(o.Amount ?? 0),
        currency: defaultCurrency(),
        won_at: `${o.CloseDate}T12:00:00Z`,
        email: role["Contact.Email"] as string | undefined,
        phone: role["Contact.Phone"] as string | undefined,
        contact_id: role["Contact.Id"] ? `sf-${role["Contact.Id"]}` : undefined,
        ...clickIds(o),
      };
    });
  },
};

const ghl: Source = {
  key: "ghl",
  title: "HighLevel (won opportunities)",
  isConfigured: () => configured("GHL_API_TOKEN", "GHL_LOCATION_ID"),
  async fetch(w) {
    const res = await callTool<{ opportunities?: Rec[] }>("ghl", "ghl_api", { path: "/opportunities/search", query: { location_id: optionalEnv("GHL_LOCATION_ID"), status: "won", limit: 100 } });
    const opps = (res.opportunities ?? []).filter((o) => inWindow(String(o.lastStatusChangeAt ?? o.updatedAt ?? ""), w));
    const out: Deal[] = [];
    for (const o of opps) {
      const c = (o.contact as Rec) ?? {};
      const full = o.contactId ? await callTool<{ contact?: Rec }>("ghl", "ghl_api", { path: `/contacts/${o.contactId}` }).then((r) => r.contact).catch(() => undefined) : undefined;
      out.push({
        source: "ghl",
        id: String(o.id),
        name: String(o.name),
        value: Number(o.monetaryValue ?? 0),
        currency: defaultCurrency(),
        won_at: new Date(String(o.lastStatusChangeAt ?? o.updatedAt)).toISOString(),
        email: (full?.email ?? c.email) as string | undefined,
        phone: (full?.phone ?? c.phone) as string | undefined,
        contact_id: o.contactId ? `ghl-${o.contactId}` : undefined,
        ...clickIds(full?.attributionSource as Rec, full?.lastAttributionSource as Rec, { attributions: full?.attributions } as Rec, { customFields: full?.customFields } as Rec),
      });
    }
    return out;
  },
};

const zoho: Source = {
  key: "zoho",
  title: "Zoho CRM (closed-won deals)",
  isConfigured: () => configured("ZOHO_REFRESH_TOKEN", "ZOHO_CLIENT_ID"),
  async fetch(w) {
    const extra = optionalEnv("CONVSYNC_ZOHO_FIELDS").split(",").map((f) => f.trim()).filter(Boolean);
    const query = `select id, Deal_Name, Amount, Closing_Date, Contact_Name, Contact_Name.Email, Contact_Name.Phone${extra.map((f) => `, ${f}`).join("")} from Deals where Stage = 'Closed Won' and Closing_Date between '${w.from}' and '${w.to}'`;
    const res = await callTool<{ rows?: Rec[] }>("zoho-crm", "zoho_crm_query", { query, max_rows: 5000 });
    return (res.rows ?? []).map((d) => ({
      source: "zoho",
      id: String(d.id),
      name: String(d.Deal_Name),
      value: Number(d.Amount ?? 0),
      currency: defaultCurrency(),
      won_at: `${d.Closing_Date}T12:00:00Z`,
      email: d["Contact_Name.Email"] as string | undefined,
      phone: d["Contact_Name.Phone"] as string | undefined,
      contact_id: d.Contact_Name ? `zoho-${typeof d.Contact_Name === "object" ? (d.Contact_Name as Rec).id : d.Contact_Name}` : undefined,
      ...clickIds(d),
    }));
  },
};

const odoo: Source = {
  key: "odoo",
  title: "Odoo CRM (won opportunities)",
  isConfigured: () => configured("ODOO_URL", "ODOO_API_KEY"),
  async fetch(w) {
    const extra = optionalEnv("CONVSYNC_ODOO_FIELDS").split(",").map((f) => f.trim()).filter(Boolean);
    const res = await callTool<{ records?: Rec[] }>("odoo", "odoo_records", {
      action: "search",
      model: "crm.lead",
      where: [["stage_id.is_won", "=", true], ["date_closed", ">=", `${w.from} 00:00:00`], ["date_closed", "<=", `${w.to} 23:59:59`]],
      fields: ["name", "expected_revenue", "email_from", "phone", "date_closed", "partner_id", "company_currency", ...extra],
      limit: 5000,
    });
    return (res.records ?? []).map((l) => ({
      source: "odoo",
      id: String(l.id),
      name: String(l.name),
      value: Number(l.expected_revenue ?? 0),
      currency: typeof l.company_currency === "string" ? l.company_currency : defaultCurrency(),
      won_at: new Date(String(l.date_closed).replace(" ", "T") + "Z").toISOString(),
      email: l.email_from as string | undefined,
      phone: l.phone as string | undefined,
      contact_id: l.partner_id ? `odoo-${l.partner_id}` : undefined,
      ...clickIds(l),
    }));
  },
};

const hubspot: Source = {
  key: "hubspot",
  title: "HubSpot (closed-won deals)",
  isConfigured: () => configured("HUBSPOT_ACCESS_TOKEN"),
  async fetch(w) {
    const res = await callTool<{ deals?: Rec[] }>("hubspot", "hubspot_won_deals", { from: w.from, to: w.to });
    return (res.deals ?? []).map((d) => ({
      source: "hubspot",
      id: String(d.id),
      name: String(d.name),
      value: Number(d.amount ?? 0),
      currency: String(d.currency ?? defaultCurrency()),
      won_at: String(d.closed_at),
      email: d.email as string | undefined,
      phone: d.phone as string | undefined,
      contact_id: d.contact_id ? `hubspot-${d.contact_id}` : undefined,
      ...clickIds(d),
    }));
  },
};

export const SOURCES: Source[] = [pipedrive, salesforce, ghl, zoho, odoo, hubspot];
