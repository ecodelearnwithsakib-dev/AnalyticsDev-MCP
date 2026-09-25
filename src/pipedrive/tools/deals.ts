import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { all, confirm, customFieldValues, day, money, PERIOD, pd, period, pipelineId, pipelineName, readableCustom, stageId, stageName, stages, userId, userName, type Rec } from "../client.js";

/** Person or organization by id, email or name; optionally created when missing. */
export async function findOrCreate(kind: "persons" | "organizations", ref: string | number, create: boolean, extra: Rec = {}): Promise<number> {
  if (typeof ref === "number" || /^\d+$/.test(ref)) return Number(ref);
  const res = await pd<{ data?: { items?: { item: Rec }[] } }>(`v2/${kind}/search`, { query: { term: ref, fields: kind === "persons" ? (ref.includes("@") ? "email" : "name") : "name", exact_match: true, limit: 5 } });
  const items = res.data?.items ?? [];
  if (items.length >= 1) return items[0].item.id as number;
  if (!create) throw new Error(`No ${kind === "persons" ? "person" : "organization"} "${ref}" — pass create_missing: true to create it`);
  const body: Rec = kind === "persons" ? (ref.includes("@") ? { name: ref.split("@")[0], emails: [{ value: ref, primary: true }] } : { name: ref }) : { name: ref };
  return (await pd<{ data: Rec }>(`v2/${kind}`, { body: { ...body, ...extra } })).data.id as number;
}

async function brief(d: Rec) {
  return {
    id: d.id,
    title: d.title,
    value: d.value,
    currency: d.currency,
    status: d.status,
    pipeline: await pipelineName(d.pipeline_id),
    stage: await stageName(d.stage_id),
    owner: await userName(d.owner_id),
    person_id: d.person_id ?? undefined,
    org_id: d.org_id ?? undefined,
    expected_close: d.expected_close_date ?? undefined,
    probability: d.probability ?? undefined,
    updated: d.update_time,
    won: d.won_time ?? undefined,
    lost: d.lost_time ?? undefined,
    lost_reason: d.lost_reason ?? undefined,
    next_activity: d.next_activity_id ?? undefined,
    custom: await readableCustom("deal", d.custom_fields as Rec),
  };
}

const DEAL = z
  .object({
    title: z.string().optional(),
    value: z.number().optional(),
    currency: z.string().optional().describe("e.g. BDT, USD"),
    person: z.union([z.string(), z.number()]).optional().describe("Person id, email or name"),
    organization: z.union([z.string(), z.number()]).optional().describe("Organization id or name"),
    owner: z.string().optional(),
    pipeline: z.string().optional(),
    stage: z.string().optional(),
    expected_close_date: z.string().optional().describe("YYYY-MM-DD, +30d, friday"),
    probability: z.number().min(0).max(100).optional(),
    label_ids: z.array(z.number()).optional(),
    visible_to: z.number().optional(),
    custom: z.record(z.unknown()).optional().describe("Custom fields by name, options by label, e.g. {\"Source\": \"Facebook\"}"),
  })
  .partial();

async function dealBody(d: z.infer<typeof DEAL>, createMissing: boolean): Promise<Rec> {
  const body: Rec = {};
  if (d.title) body.title = d.title;
  if (d.value !== undefined) body.value = d.value;
  if (d.currency) body.currency = d.currency;
  if (d.organization !== undefined) body.org_id = await findOrCreate("organizations", d.organization, createMissing);
  if (d.person !== undefined) body.person_id = await findOrCreate("persons", d.person, createMissing, body.org_id ? { org_id: body.org_id } : {});
  if (d.owner) body.owner_id = await userId(d.owner);
  if (d.stage) Object.assign(body, await stageId(d.stage, d.pipeline));
  else if (d.pipeline) body.pipeline_id = await pipelineId(d.pipeline);
  if (d.expected_close_date) body.expected_close_date = day(d.expected_close_date);
  if (d.probability !== undefined) body.probability = d.probability;
  if (d.label_ids) body.label_ids = d.label_ids;
  if (d.visible_to) body.visible_to = d.visible_to;
  if (d.custom) body.custom_fields = await customFieldValues("deal", d.custom);
  return body;
}

export function registerDealTools(server: McpServer): void {
  server.registerTool(
    "pipedrive_deals",
    {
      title: "Deals",
      description:
        "Deals: list (status, pipeline/stage by name, owner, person, organization, updated since, a saved filter), get (with custom fields by name, participants, products and recent activities/notes), create (person and organization by name/email — created if missing), update, move stage, mark won, mark lost with reason, reopen, delete (confirm), duplicate, and list/add products on a deal.",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "move", "won", "lost", "reopen", "delete", "duplicate", "products", "add_product"]),
        id: z.number().int().optional(),
        deal: DEAL.optional(),
        create_missing: z.boolean().default(true).describe("Create person/organization if not found"),
        status: z.enum(["open", "won", "lost", "deleted", "all_not_deleted"]).default("open"),
        pipeline: z.string().optional(),
        stage: z.string().optional(),
        owner: z.string().optional(),
        person_id: z.number().int().optional(),
        org_id: z.number().int().optional(),
        filter_id: z.number().int().optional(),
        updated_since: z.string().optional(),
        lost_reason: z.string().optional(),
        product: z.object({ product_id: z.number().int(), price: z.number(), quantity: z.number().default(1), discount: z.number().optional() }).optional(),
        limit: z.number().int().min(1).max(5000).default(100),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const need = () => {
          if (!a.id) throw new Error("id is required");
          return a.id;
        };
        switch (a.action) {
          case "list": {
            const query: Rec = { status: a.status === "all_not_deleted" ? undefined : a.status, owner_id: a.owner ? await userId(a.owner) : undefined, person_id: a.person_id, org_id: a.org_id, filter_id: a.filter_id, updated_since: a.updated_since ? `${day(a.updated_since)}T00:00:00Z` : undefined, sort_by: "update_time", sort_direction: "desc", include_fields: "next_activity_id" };
            if (a.stage) query.stage_id = (await stageId(a.stage, a.pipeline)).stage_id;
            else if (a.pipeline) query.pipeline_id = await pipelineId(a.pipeline);
            const rows = await all("v2/deals", query as Record<string, string>, a.limit);
            return { count: rows.length, value: money(rows.reduce((s, d) => s + (Number(d.value) || 0), 0)), deals: await Promise.all(rows.map(brief)) };
          }
          case "get": {
            const d = (await pd<{ data: Rec }>(`v2/deals/${need()}`, { query: { include_fields: "next_activity_id,last_activity_id,activities_count,notes_count,products_count" } })).data;
            const [acts, notes, products] = await Promise.all([
              all("v2/activities", { deal_id: a.id, sort_by: "due_date", sort_direction: "desc" } as Record<string, number | string>, 10).catch(() => []),
              pd<{ data?: Rec[] }>("v1/notes", { query: { deal_id: a.id, limit: 5, sort: "add_time DESC" } }).then((r) => r.data ?? []).catch(() => []),
              pd<{ data?: Rec[] }>(`v2/deals/${a.id}/products`).then((r) => r.data ?? []).catch(() => []),
            ]);
            return {
              ...(await brief(d)),
              recent_activities: acts.map((x) => ({ id: x.id, subject: x.subject, type: x.type, due: x.due_date, done: x.done })),
              recent_notes: notes.map((n) => ({ id: n.id, at: n.add_time, text: String(n.content ?? "").replace(/<[^>]+>/g, " ").trim().slice(0, 300) })),
              products: products.map((p) => ({ product_id: p.product_id, name: p.name, price: p.item_price, qty: p.quantity, sum: p.sum })),
            };
          }
          case "create": {
            if (!a.deal?.title) throw new Error("deal.title is required");
            const d = (await pd<{ data: Rec }>("v2/deals", { body: await dealBody(a.deal, a.create_missing) })).data;
            return { created: d.id, ...(await brief(d)) };
          }
          case "update":
          case "move": {
            const stageWanted = a.stage ?? a.deal?.stage;
            let pipeline = a.pipeline ?? a.deal?.pipeline;
            // A stage name is looked up in the deal's current pipeline unless another pipeline is given.
            if (stageWanted && !pipeline) pipeline = String((await pd<{ data: Rec }>(`v2/deals/${need()}`)).data.pipeline_id);
            const body = await dealBody({ ...a.deal, ...(stageWanted ? { stage: stageWanted, pipeline } : {}) }, a.create_missing);
            if (!Object.keys(body).length) throw new Error("Nothing to change — pass deal fields or stage");
            const d = (await pd<{ data: Rec }>(`v2/deals/${need()}`, { method: "PATCH", body })).data;
            return { updated: d.id, stage: await stageName(d.stage_id), pipeline: await pipelineName(d.pipeline_id) };
          }
          case "won":
          case "reopen":
            await pd(`v2/deals/${need()}`, { method: "PATCH", body: { status: a.action === "won" ? "won" : "open" } });
            return { id: a.id, status: a.action === "won" ? "won" : "open" };
          case "lost":
            await pd(`v2/deals/${need()}`, { method: "PATCH", body: { status: "lost", lost_reason: a.lost_reason } });
            return { id: a.id, status: "lost", reason: a.lost_reason };
          case "delete":
            if (!a.confirm) throw new Error("Deleting a deal (recoverable for 30 days) — prefer marking it lost; set confirm: true");
            await pd(`v2/deals/${need()}`, { method: "DELETE" });
            return { deleted: a.id };
          case "duplicate":
            return { duplicate: ((await pd<{ data: Rec }>(`v1/deals/${need()}/duplicate`, { method: "POST" })).data ?? {}).id };
          case "products":
            return ((await pd<{ data?: Rec[] }>(`v2/deals/${need()}/products`)).data ?? []).map((p) => ({ id: p.id, product_id: p.product_id, name: p.name, price: p.item_price, qty: p.quantity, discount: p.discount, sum: p.sum }));
          case "add_product":
            if (!a.product) throw new Error("product is required");
            return (await pd<{ data: Rec }>(`v2/deals/${need()}/products`, { body: { product_id: a.product.product_id, item_price: a.product.price, quantity: a.product.quantity, discount: a.product.discount } })).data;
        }
      }),
  );

  server.registerTool(
    "pipedrive_leads",
    {
      title: "Leads inbox",
      description: "Leads (before they become deals): list (archived or not, owner, person/org), create (person/org by name or email, value, labels, expected close), update, archive/unarchive, convert to a deal, delete (confirm), and list lead labels.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "archive", "unarchive", "convert", "delete", "labels"]),
        id: z.string().optional().describe("Lead UUID"),
        title: z.string().optional(),
        person: z.union([z.string(), z.number()]).optional(),
        organization: z.union([z.string(), z.number()]).optional(),
        owner: z.string().optional(),
        value: z.number().optional(),
        currency: z.string().optional(),
        labels: z.array(z.string()).optional().describe("Lead label names"),
        expected_close_date: z.string().optional(),
        archived: z.boolean().default(false),
        pipeline: z.string().optional().describe("convert: target pipeline"),
        stage: z.string().optional().describe("convert: target stage"),
        create_missing: z.boolean().default(true),
        limit: z.number().int().min(1).max(2000).default(100),
        confirm,
      },
    },
    (a) =>
      run(async () => {
        const labelIds = async () => {
          if (!a.labels) return undefined;
          const list = (await pd<{ data: { id: string; name: string }[] }>("v1/leadLabels")).data ?? [];
          return a.labels.map((n) => {
            const l = list.find((x) => x.name.toLowerCase() === n.toLowerCase());
            if (!l) throw new Error(`No lead label "${n}" — labels: ${list.map((x) => x.name).join(", ")}`);
            return l.id;
          });
        };
        const body = async (): Promise<Rec> => {
          const b: Rec = {};
          if (a.title) b.title = a.title;
          if (a.organization !== undefined) b.organization_id = await findOrCreate("organizations", a.organization, a.create_missing);
          if (a.person !== undefined) b.person_id = await findOrCreate("persons", a.person, a.create_missing, b.organization_id ? { org_id: b.organization_id } : {});
          if (a.owner) b.owner_id = await userId(a.owner);
          if (a.value !== undefined) b.value = { amount: a.value, currency: a.currency ?? "USD" };
          const l = await labelIds();
          if (l) b.label_ids = l;
          if (a.expected_close_date) b.expected_close_date = day(a.expected_close_date);
          return b;
        };
        const need = () => {
          if (!a.id) throw new Error("id (lead UUID) is required");
          return a.id;
        };
        switch (a.action) {
          case "list": {
            const rows = await all("v1/leads", { archived_status: a.archived ? "archived" : "not_archived", owner_id: a.owner ? await userId(a.owner) : undefined, sort: "add_time DESC" }, a.limit);
            return { count: rows.length, leads: await Promise.all(rows.map(async (l) => ({ id: l.id, title: l.title, value: (l.value as Rec)?.amount, currency: (l.value as Rec)?.currency, person_id: l.person_id, org_id: l.organization_id, owner: await userName(l.owner_id), labels: l.label_ids, source: l.source_name, added: l.add_time, expected_close: l.expected_close_date }))) };
          }
          case "create": {
            const b = await body();
            if (!b.title) throw new Error("title is required");
            if (!b.person_id && !b.organization_id) throw new Error("person or organization is required for a lead");
            return { created: ((await pd<{ data: Rec }>("v1/leads", { body: b })).data ?? {}).id };
          }
          case "update":
            await pd(`v1/leads/${need()}`, { method: "PATCH", body: await body() });
            return { updated: a.id };
          case "archive":
          case "unarchive":
            await pd(`v1/leads/${need()}`, { method: "PATCH", body: { is_archived: a.action === "archive" } });
            return { [a.action === "archive" ? "archived" : "restored"]: a.id };
          case "convert": {
            const target: Rec = {};
            if (a.stage) target.stage_id = (await stageId(a.stage, a.pipeline)).stage_id;
            else if (a.pipeline) target.pipeline_id = await pipelineId(a.pipeline);
            const res = await pd<{ data?: Rec }>(`v2/leads/${need()}/convert/deal`, { body: target });
            return { converted: a.id, job: res.data };
          }
          case "delete":
            if (!a.confirm) throw new Error("Deleting a lead is permanent — prefer archive; set confirm: true");
            await pd(`v1/leads/${need()}`, { method: "DELETE" });
            return { deleted: a.id };
          case "labels":
            return (await pd<{ data: Rec[] }>("v1/leadLabels")).data;
        }
      }),
  );

  server.registerTool(
    "pipedrive_report",
    {
      title: "Sales report",
      description:
        "Pipeline numbers: open deals by stage (count, value, probability-weighted value), won and lost in a period (count, value, win rate, average deal size, average days to close), lost reasons, per-owner totals, and rotting deals (open deals stuck longer than their stage's rotting days or without a next activity).",
      inputSchema: {
        preset: PERIOD.describe("Window for won/lost, default this_month"),
        from: z.string().optional(),
        to: z.string().optional(),
        pipeline: z.string().optional(),
        owner: z.string().optional(),
      },
    },
    (a) =>
      run(async () => {
        const p = period(a.preset, a.from, a.to);
        const scope: Record<string, number | undefined> = { pipeline_id: a.pipeline ? await pipelineId(a.pipeline) : undefined, owner_id: a.owner ? await userId(a.owner) : undefined };
        const [open, won, lost, stageList] = await Promise.all([
          all("v2/deals", { ...scope, status: "open", include_fields: "next_activity_id" } as Record<string, number | string>, 20000),
          all("v2/deals", { ...scope, status: "won", updated_since: `${p.from}T00:00:00Z` } as Record<string, number | string>, 20000),
          all("v2/deals", { ...scope, status: "lost", updated_since: `${p.from}T00:00:00Z` } as Record<string, number | string>, 20000),
          stages(),
        ]);
        const inWindow = (t: unknown) => t && String(t).slice(0, 10) >= p.from && String(t).slice(0, 10) <= p.to;
        const wonIn = won.filter((d) => inWindow(d.won_time));
        const lostIn = lost.filter((d) => inWindow(d.lost_time));
        const byStage = new Map<number, { stage: string; pipeline?: string; deals: number; value: number; weighted: number }>();
        for (const d of open) {
          const s = stageList.find((x) => x.id === d.stage_id);
          const t = byStage.get(Number(d.stage_id)) ?? { stage: s?.name ?? String(d.stage_id), pipeline: await pipelineName(d.pipeline_id), deals: 0, value: 0, weighted: 0 };
          t.deals++;
          t.value += Number(d.value) || 0;
          t.weighted += ((Number(d.value) || 0) * Number(d.probability ?? s?.deal_probability ?? 100)) / 100;
          byStage.set(Number(d.stage_id), t);
        }
        const owners = new Map<string, { owner: string; open: number; open_value: number; won: number; won_value: number; lost: number }>();
        const o = async (d: Rec) => {
          const k = String(d.owner_id);
          if (!owners.has(k)) owners.set(k, { owner: String(await userName(d.owner_id)), open: 0, open_value: 0, won: 0, won_value: 0, lost: 0 });
          return owners.get(k)!;
        };
        for (const d of open) ((await o(d)).open++, ((await o(d)).open_value += Number(d.value) || 0));
        for (const d of wonIn) ((await o(d)).won++, ((await o(d)).won_value += Number(d.value) || 0));
        for (const d of lostIn) (await o(d)).lost++;
        const reasons: Record<string, number> = {};
        for (const d of lostIn) reasons[String(d.lost_reason || "(none)")] = (reasons[String(d.lost_reason || "(none)")] ?? 0) + 1;
        const wonValue = wonIn.reduce((s, d) => s + (Number(d.value) || 0), 0);
        const cycle = wonIn.map((d) => (Date.parse(String(d.won_time)) - Date.parse(String(d.add_time))) / 86_400_000).filter((x) => x >= 0);
        const now = Date.now();
        const rotting = open
          .filter((d) => {
            const s = stageList.find((x) => x.id === d.stage_id);
            const since = Date.parse(String(d.stage_change_time ?? d.add_time));
            return (s?.rotten_days && now - since > s.rotten_days * 86_400_000) || !d.next_activity_id;
          })
          .slice(0, 50);
        return {
          window: p,
          open: { deals: open.length, value: money(open.reduce((s, d) => s + (Number(d.value) || 0), 0)), weighted: money([...byStage.values()].reduce((s, x) => s + x.weighted, 0)), by_stage: [...byStage.values()].map((x) => ({ ...x, value: money(x.value), weighted: money(x.weighted) })) },
          won: { deals: wonIn.length, value: money(wonValue), average_deal: wonIn.length ? money(wonValue / wonIn.length) : 0, average_days_to_close: cycle.length ? Math.round(cycle.reduce((s, x) => s + x, 0) / cycle.length) : null },
          lost: { deals: lostIn.length, reasons },
          win_rate_pct: wonIn.length + lostIn.length ? Math.round((wonIn.length / (wonIn.length + lostIn.length)) * 1000) / 10 : null,
          by_owner: [...owners.values()].map((x) => ({ ...x, open_value: money(x.open_value), won_value: money(x.won_value) })).sort((x, y) => y.won_value - x.won_value),
          needs_attention: await Promise.all(rotting.map(async (d) => ({ id: d.id, title: d.title, value: d.value, stage: await stageName(d.stage_id), owner: await userName(d.owner_id), no_next_activity: !d.next_activity_id || undefined, in_stage_since: String(d.stage_change_time ?? d.add_time).slice(0, 10) }))),
        };
      }),
  );
}
