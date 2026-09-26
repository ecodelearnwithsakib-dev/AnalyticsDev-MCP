#!/usr/bin/env node
/**
 * Command-line runner for schedules and manual runs:
 *   node dist/monitor/cli.js check  [--slack "#alerts"] [--only-if-alerts] [--send]
 *   node dist/monitor/cli.js report [--slack "#marketing"] [--revenue ga4] [--save] [--html] [--preset last_7_days] [--send]
 * Without --send, Slack messages are only printed.
 */
import { closeChildren } from "../shared/hub.js";
import { runCheck, runReport } from "./actions.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const value = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

try {
  if (argv[0] === "check") {
    const r = await runCheck({ slack_channel: value("slack"), send: flag("send"), only_if_alerts: flag("only-if-alerts") });
    console.log(r.message);
    process.exitCode = r.alerts.some((a) => a.severity === "critical") ? 2 : 0;
  } else if (argv[0] === "report") {
    const r = await runReport({ preset: value("preset"), revenue_source: value("revenue") ?? "none", slack_channel: value("slack"), save: flag("save"), format: flag("html") ? "html" : "markdown", send: flag("send") });
    console.log(r.markdown ?? `Saved ${r.saved}`);
  } else {
    console.log("Usage: monitor check|report [--slack #channel] [--send] …");
  }
} finally {
  await closeChildren();
}
