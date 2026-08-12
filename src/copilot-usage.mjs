#!/usr/bin/env node

import {
  aggregateCreditUsage,
  aggregateDailyCreditUsage,
  aggregateDailyUserCreditUsage,
  aggregateUserMetrics,
  attachUserCreditUsage,
  computeIncludedCreditsPool,
  normalizeAiCreditBudgets,
  percentage,
} from "./aggregate.mjs";
import { GitHubApiError, GitHubClient } from "./github-api.mjs";

function usage() {
  return `Usage:
  node src/copilot-usage.mjs --enterprise ENTERPRISE_SLUG [options]

Options:
  --enterprise SLUG     Enterprise slug
  --year YYYY           Billing year; defaults to current UTC year
  --month MM            Billing month; defaults to current UTC month
  --no-users            Skip month-to-date per-user metrics
  --user-report-day DAY Fetch one day instead of month-to-date (diagnostic)
  --pretty              Pretty-print JSON
  --help                Show this help

Authentication:
  Set GITHUB_TOKEN or GH_TOKEN in the environment.
`;
}

export function parseArgs(argv, now = new Date()) {
  const options = {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    includeUsers: true,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pretty") {
      options.pretty = true;
    } else if (argument === "--no-users") {
      options.includeUsers = false;
    } else if (argument === "--help") {
      options.help = true;
    } else if (argument.startsWith("--")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      if (argument === "--enterprise") options.enterprise = value;
      else if (argument === "--year") options.year = Number(value);
      else if (argument === "--month") options.month = Number(value);
      else if (argument === "--user-report-day") {
        options.userReportDay = value;
        options.includeUsers = true;
      }
      else throw new Error(`Unknown option: ${argument}`);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (options.help) {
    return options;
  }
  if (!options.enterprise) {
    throw new Error("--enterprise is required");
  }
  if (!Number.isInteger(options.year) || options.year < 2000) {
    throw new Error("--year must be a four-digit year");
  }
  if (!Number.isInteger(options.month) || options.month < 1 || options.month > 12) {
    throw new Error("--month must be between 1 and 12");
  }
  if (
    options.userReportDay &&
    !/^\d{4}-\d{2}-\d{2}$/.test(options.userReportDay)
  ) {
    throw new Error("--user-report-day must use YYYY-MM-DD");
  }

  return options;
}

export function getMonthReportDays({ year, month }, now = new Date()) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const endDay = lastDay < yesterday ? lastDay : yesterday;

  if (endDay < firstDay) {
    return [];
  }

  const days = [];
  for (
    const day = new Date(firstDay);
    day <= endDay;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

export async function buildReport(options, client) {
  const days = options.userReportDay
    ? [options.userReportDay]
    : getMonthReportDays(options, options.now);

  const requests = [
    client.getCreditUsage(options),
    client.getBudgets(options),
    client.getCopilotSeats(options),
    days.length > 0
      ? client.getDailyCreditUsageReports({
          enterprise: options.enterprise,
          year: options.year,
          month: options.month,
          days,
        })
      : Promise.resolve({ reports: [], failures: [] }),
  ];

  if (options.userReportDay) {
    requests.push(client.getUserReport({
      enterprise: options.enterprise,
      day: options.userReportDay,
    }).then((report) => ({
      mode: "day",
      startDay: options.userReportDay,
      endDay: options.userReportDay,
      records: report.records,
      coverage: {
        latest28Day: null,
        targetDays: 1,
        coveredByLatest28Day: 0,
        dailyReportsRequested: 1,
        dailyReportsWithContent: report.available ? 1 : 0,
        noContentDays: report.available ? [] : [report.reportDay],
      },
    })));
  } else if (options.includeUsers) {
    requests.push(client.getMonthUserReports({
      enterprise: options.enterprise,
      days,
    }).then((result) => ({
      mode: "month-to-date",
      startDay: days[0] ?? null,
      endDay: days.at(-1) ?? null,
      ...result,
    })));
  } else {
    requests.push(Promise.resolve(null));
  }

  const [usage, budgets, copilotDetails, dailyBilling, userReport] =
    await Promise.all(requests);
  const credits = aggregateCreditUsage(usage?.usageItems);
  const dailyUsage = {
    days,
    byModel: aggregateDailyCreditUsage(dailyBilling.reports),
    byUser: userReport
      ? aggregateDailyUserCreditUsage(userReport.records)
      : null,
    billingFailures: dailyBilling.failures,
  };
  const aiCreditBudgets = normalizeAiCreditBudgets(budgets);
  const period = usage?.timePeriod ?? { year: options.year, month: options.month };
  const pool = computeIncludedCreditsPool(copilotDetails?.seats, period);
  const aggregatedUsers = userReport
    ? aggregateUserMetrics(userReport.records)
    : null;
  const userCreditUsage = aggregatedUsers
    ? await client.getUserCreditUsageReports({
        enterprise: options.enterprise,
        year: options.year,
        month: options.month,
        users: aggregatedUsers,
      })
    : null;
  const users = aggregatedUsers
    ? attachUserCreditUsage(aggregatedUsers, userCreditUsage.reports)
    : null;
  const userAnalyticsCredits = users
    ? users.reduce((sum, user) => sum + user.aiCreditsUsed, 0)
    : null;
  const attributedBillingGrossCredits = users
    ? users.reduce(
        (sum, user) => sum + (user.billingCredits?.grossUsed ?? 0),
        0,
      )
    : null;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: { type: "enterprise", slug: options.enterprise },
    period,
    credits: {
      grossUsed: credits.grossUsed,
      discounted: credits.discounted,
      netBillable: credits.netBillable,
      grossValueUsd: credits.grossValueUsd,
      netChargeUsd: credits.netChargeUsd,
    },
    limits: {
      includedCredits: pool.includedCredits,
      effectiveLimit: pool.includedCredits,
      percentUsed: percentage(credits.grossUsed, pool.includedCredits),
      includedCreditsBasis: {
        ratesPerSeatPerMonth: pool.ratesPerSeatPerMonth,
        promoActive: pool.promoActive,
        warnings: pool.warnings,
      },
      aiCreditBudgets,
    },
    copilot: {
      planType: null,
      totalSeats: copilotDetails?.totalSeats ?? null,
      seatBreakdown: pool.seatBreakdown,
      assignmentRecordCount: copilotDetails?.seats?.length ?? null,
    },
    models: credits.models,
    dailyUsage,
    userMetrics: userReport
      ? {
          period: {
            mode: userReport.mode,
            startDay: userReport.startDay,
            endDay: userReport.endDay,
            ...userReport.coverage,
          },
          summary: {
            userCount: users.length,
            analyticsCreditsUsed: userAnalyticsCredits,
            billingGrossCredits: credits.grossUsed,
            differenceFromBilling: userAnalyticsCredits - credits.grossUsed,
            expectedToReconcileWithBilling: false,
            billingBreakdown: {
              requestedUserCount: users.length,
              successfulUserCount: userCreditUsage.reports.length,
              failedUserCount: userCreditUsage.failures.length,
              complete: userCreditUsage.failures.length === 0,
              attributedGrossCredits: attributedBillingGrossCredits,
              unattributedGrossCredits:
                credits.grossUsed - attributedBillingGrossCredits,
            },
          },
          percentageBasis: {
            billingCredits: "grossQuantity",
            interactions: "user_initiated_interaction_count",
            codeGenerations: "code_generation_activity_count",
          },
          billingFailures: userCreditUsage.failures,
          users,
        }
      : null,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  try {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const client = new GitHubClient({ token });
    const report = await buildReport(options, client);
    const spacing = options.pretty ? 2 : 0;
    process.stdout.write(`${JSON.stringify(report, null, spacing)}\n`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error instanceof GitHubApiError && error.body) {
      console.error(error.body);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await main();
}
