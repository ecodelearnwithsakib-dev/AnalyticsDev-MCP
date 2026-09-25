import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../../shared/server.js";
import { accountId, download, ids, msads, parseCsv, schema, unzipFirst } from "../client.js";

const METRICS = ["Impressions", "Clicks", "Spend", "Ctr", "AverageCpc", "Conversions", "CostPerConversion", "Revenue", "ReturnOnAdSpend"];

/** Report type → wire request type and default columns (all verified against each report's column enum). */
const REPORTS = {
  account: { type: "AccountPerformanceReportRequest", columns: ["AccountName", "AccountId", ...METRICS, "ImpressionSharePercent"] },
  campaign: { type: "CampaignPerformanceReportRequest", columns: ["CampaignName", "CampaignId", "CampaignStatus", ...METRICS, "ImpressionSharePercent"] },
  ad_group: { type: "AdGroupPerformanceReportRequest", columns: ["CampaignName", "AdGroupName", "AdGroupId", ...METRICS] },
  ad: { type: "AdPerformanceReportRequest", columns: ["CampaignName", "AdGroupName", "AdId", "AdTitle", "AdType", "AdStatus", "FinalUrl", ...METRICS] },
  keyword: { type: "KeywordPerformanceReportRequest", columns: ["CampaignName", "AdGroupName", "Keyword", "KeywordId", "KeywordStatus", "BidMatchType", "QualityScore", ...METRICS] },
  search_query: { type: "SearchQueryPerformanceReportRequest", columns: ["CampaignName", "AdGroupName", "SearchQuery", "Keyword", "DeliveredMatchType", ...METRICS] },
  geographic: { type: "GeographicPerformanceReportRequest", columns: ["CampaignName", "Country", "State", "City", "LocationType", ...METRICS] },
  asset_group: { type: "AssetGroupPerformanceReportRequest", columns: ["CampaignName", "AssetGroupName", "AssetGroupId", "Impressions", "Clicks", "Spend", "Ctr", "AverageCpc", "Conversions", "CostPerConversion", "Revenue", "ReturnOnAdSpend"] },
  product: { type: "ProductDimensionPerformanceReportRequest", columns: ["CampaignName", "MerchantProductId", "Title", "Brand", ...METRICS] },
  age_gender: { type: "AgeGenderAudienceReportRequest", columns: ["CampaignName", "AgeGroup", "Gender", "Impressions", "Clicks", "Spend", "Conversions", "Revenue"] },
} as const;

const day = (iso: string) => {
  const [Year, Month, Day] = iso.split("-").map(Number);
  return { Year, Month, Day };
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

type Row = Record<string, unknown>;
const total = (rows: Row[], col: string) => rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);

export async function runReport(opts: {
  report: keyof typeof REPORTS;
  accountIds: string[];
  campaignIds?: string[];
  columns?: string[];
  aggregation: string;
  from: string;
  to: string;
  predefined?: string;
  waitSeconds: number;
}) {
  const def = REPORTS[opts.report];
  const columns = opts.columns ?? [...(opts.aggregation === "Summary" ? [] : ["TimePeriod"]), ...def.columns];
  const scope =
    opts.report === "account"
      ? { AccountIds: ids(opts.accountIds) }
      : {
          AccountIds: opts.campaignIds?.length ? null : ids(opts.accountIds),
          Campaigns: opts.campaignIds?.length ? opts.campaignIds.map((c) => ({ AccountId: String(opts.accountIds[0]), CampaignId: String(c) })) : null,
        };
  const submitted = (await msads(
    "reporting",
    "POST",
    "GenerateReport/Submit",
    {
      ReportRequest: {
        Type: def.type,
        Format: "Csv",
        FormatVersion: "2.0",
        ReportName: `mcp ${opts.report}`,
        ExcludeReportHeader: true,
        ExcludeReportFooter: true,
        ExcludeColumnHeaders: false,
        ReturnOnlyCompleteData: false,
        Aggregation: opts.aggregation,
        Columns: columns,
        Scope: scope,
        Time: opts.predefined
          ? { PredefinedTime: opts.predefined, ReportTimeZone: null }
          : { CustomDateRangeStart: day(opts.from), CustomDateRangeEnd: day(opts.to), ReportTimeZone: null },
      },
    },
    { accountId: opts.accountIds[0] },
  )) as { ReportRequestId: string };

  const deadline = Date.now() + opts.waitSeconds * 1000;
  let status: { Status?: string; ReportDownloadUrl?: string | null } = {};
  for (let wait = 1000; Date.now() < deadline; wait = Math.min(wait * 2, 8000)) {
    const res = (await msads("reporting", "POST", "GenerateReport/Poll", { ReportRequestId: submitted.ReportRequestId }, { accountId: opts.accountIds[0] })) as {
      ReportRequestStatus?: typeof status;
    };
    status = res.ReportRequestStatus ?? {};
    if (status.Status === "Success" || status.Status === "Error") break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (status.Status === "Error") throw new Error(`Report ${submitted.ReportRequestId} failed on Microsoft's side`);
  if (status.Status !== "Success") return { report_request_id: submitted.ReportRequestId, status: status.Status ?? "Pending", note: "Still running; call again with a longer wait_seconds" };
  if (!status.ReportDownloadUrl) return { rows: [], note: "No data for this period" };
  return { rows: parseCsv(unzipFirst(await download(status.ReportDownloadUrl)).toString("utf8")), columns };
}

export function registerReportingTools(server: McpServer): void {
  server.registerTool(
    "msads_report",
    {
      title: "Performance report",
      description:
        "Microsoft Advertising (Bing) performance report: account, campaign, ad group, ad, keyword, search query (search terms), geographic, Performance Max asset group, product or age/gender — by summary, day, week or month. Returns rows plus totals with CTR, CPC, CPA and ROAS. Spend/revenue are in account currency.",
      inputSchema: {
        report: z.enum(Object.keys(REPORTS) as [keyof typeof REPORTS, ...(keyof typeof REPORTS)[]]).default("campaign"),
        aggregation: z.enum(["Summary", "Daily", "Weekly", "Monthly", "Hourly", "DayOfWeek", "HourOfDay"]).default("Summary"),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD; defaults to yesterday"),
        last_days: z.number().int().min(1).max(1095).default(7),
        predefined_time: z.enum(["Today", "Yesterday", "LastSevenDays", "ThisWeek", "LastWeek", "Last14Days", "Last30Days", "LastFourWeeks", "ThisMonth", "LastMonth", "LastThreeMonths", "LastSixMonths", "ThisYear", "LastYear"]).optional(),
        campaign_ids: z.array(z.string()).optional().describe("Limit to these campaigns"),
        account_ids: z.array(z.string()).optional().describe("Several accounts at once; defaults to MSADS_ACCOUNT_ID"),
        columns: z.array(z.string()).optional().describe("Override report columns, e.g. [\"CampaignName\",\"DeviceType\",\"Clicks\",\"Spend\"]"),
        min_spend: z.number().optional().describe("Drop rows with lower spend"),
        sort_by: z.string().default("Spend"),
        limit: z.number().int().min(1).max(10000).default(200),
        wait_seconds: z.number().int().min(5).max(300).default(90),
      },
    },
    (a) =>
      run(async () => {
        const to = a.date_to ?? isoDay(new Date(Date.now() - 86_400_000));
        const from = a.date_from ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - (a.last_days - 1) * 86_400_000));
        const result = await runReport({
          report: a.report,
          accountIds: a.account_ids ?? [accountId()],
          campaignIds: a.campaign_ids,
          columns: a.columns,
          aggregation: a.aggregation,
          from,
          to,
          predefined: a.predefined_time,
          waitSeconds: a.wait_seconds,
        });
        const reportRows = "rows" in result ? result.rows : undefined;
        if (!reportRows?.length) return { range: a.predefined_time ?? { from, to }, ...result };
        let rows: Row[] = reportRows;
        if (a.min_spend !== undefined) rows = rows.filter((r) => Number(r.Spend) >= a.min_spend!);
        rows.sort((x, y) => (Number(y[a.sort_by]) || 0) - (Number(x[a.sort_by]) || 0));
        const spend = total(rows, "Spend");
        const clicks = total(rows, "Clicks");
        const impressions = total(rows, "Impressions");
        const conversions = total(rows, "Conversions");
        const revenue = total(rows, "Revenue");
        return {
          range: a.predefined_time ?? { from, to },
          totals: {
            impressions,
            clicks,
            spend: round(spend),
            conversions: round(conversions),
            revenue: round(revenue),
            ctr: impressions ? round((clicks / impressions) * 100) : null,
            cpc: clicks ? round(spend / clicks) : null,
            cpa: conversions ? round(spend / conversions) : null,
            roas: spend ? round(revenue / spend) : null,
          },
          row_count: rows.length,
          rows: rows.slice(0, a.limit),
        };
      }),
  );

  server.registerTool(
    "msads_accounts",
    {
      title: "Accounts",
      description: "The signed-in user and every Microsoft Advertising account they can access (ID, number, name, currency, time zone, status, parent customer). Use the Id as MSADS_ACCOUNT_ID.",
      inputSchema: { account_id: schema.account_id.describe("Get full details of one account instead") },
    },
    ({ account_id }) =>
      run(async () => {
        if (account_id) return msads("customer", "POST", "Account/Query", { AccountId: account_id });
        const me = (await msads("customer", "POST", "User/Query", { UserId: null })) as { User?: { Id?: string; UserName?: string; Name?: unknown }; CustomerRoles?: unknown[] };
        const res = (await msads("customer", "POST", "Accounts/Search", {
          Predicates: [{ Field: "UserId", Operator: "Equals", Value: String(me.User?.Id) }],
          Ordering: null,
          PageInfo: { Index: 0, Size: 1000 },
        })) as { Accounts?: Record<string, unknown>[] };
        return {
          user: { id: me.User?.Id, user_name: me.User?.UserName, name: me.User?.Name },
          customer_roles: me.CustomerRoles,
          accounts: (res.Accounts ?? []).map((acc) => ({
            id: acc.Id,
            number: acc.Number,
            name: acc.Name,
            customer_id: acc.ParentCustomerId,
            currency: acc.CurrencyCode,
            time_zone: acc.TimeZone,
            status: acc.AccountLifeCycleStatus,
            pause_reason: acc.PauseReason,
          })),
        };
      }),
  );
}
