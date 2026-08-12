import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCreditUsage,
  aggregateUserMetrics,
  attachUserCreditUsage,
  computeIncludedCreditsPool,
  normalizeAiCreditBudgets,
} from "../src/aggregate.mjs";
import {
  buildReport,
  getMonthReportDays,
  parseArgs,
} from "../src/copilot-usage.mjs";

test("aggregateCreditUsage totals credits and computes model percentages", () => {
  const result = aggregateCreditUsage([
    {
      model: "Model A",
      grossQuantity: 75,
      discountQuantity: 70,
      netQuantity: 5,
      grossAmount: 0.75,
      netAmount: 0.05,
    },
    {
      model: "Model B",
      grossQuantity: 25,
      discountQuantity: 25,
      netQuantity: 0,
      grossAmount: 0.25,
      netAmount: 0,
    },
  ]);

  assert.equal(result.grossUsed, 100);
  assert.equal(result.netBillable, 5);
  assert.equal(result.models[0].model, "Model A");
  assert.equal(result.models[0].percentageOfGrossCredits, 75);
  assert.equal(result.models[1].percentageOfGrossCredits, 25);
});

test("normalizeAiCreditBudgets excludes unrelated product budgets", () => {
  const result = normalizeAiCreditBudgets([
    {
      id: "ai",
      budget_product_skus: ["ai_credits"],
      budget_scope: "enterprise",
      budget_amount: 50,
      prevent_further_usage: true,
    },
    {
      id: "actions",
      budget_product_skus: ["actions"],
      budget_amount: 100,
    },
  ]);

  assert.deepEqual(result, [
    {
      id: "ai",
      scope: "enterprise",
      entityName: null,
      amountUsd: 50,
      equivalentCredits: 5000,
      preventsFurtherUsage: true,
    },
  ]);
});

test("computeIncludedCreditsPool applies standard rates outside the promo window", () => {
  const seats = [
    { assignee: { id: 1 }, plan_type: "business" },
    { assignee: { id: 2 }, plan_type: "business" },
    { assignee: { id: 3 }, plan_type: "enterprise" },
  ];

  const before = computeIncludedCreditsPool(seats, { year: 2026, month: 5 });
  const after = computeIncludedCreditsPool(seats, { year: 2026, month: 9 });

  for (const pool of [before, after]) {
    assert.equal(pool.promoActive, false);
    assert.deepEqual(pool.seatBreakdown, { business: 2, enterprise: 1, unknown: 0 });
    assert.equal(pool.includedCredits, 2 * 1900 + 3900);
  }
});

test("computeIncludedCreditsPool applies promotional rates for 2026-06 through 2026-08", () => {
  const seats = [
    { assignee: { id: 1 }, plan_type: "business" },
    { assignee: { id: 2 }, plan_type: "enterprise" },
  ];

  for (const month of [6, 7, 8]) {
    const pool = computeIncludedCreditsPool(seats, { year: 2026, month });
    assert.equal(pool.promoActive, true, `month ${month} should be promo`);
    assert.equal(pool.includedCredits, 3000 + 7000);
  }
});

test("computeIncludedCreditsPool dedupes seats by assignee id", () => {
  const seats = [
    { assignee: { id: 42 }, plan_type: "business", organization: null },
    { assignee: { id: 42 }, plan_type: "business", organization: { login: "some-org" } },
  ];

  const pool = computeIncludedCreditsPool(seats, { year: 2026, month: 7 });

  assert.equal(pool.uniqueSeatCount, 1);
  assert.deepEqual(pool.seatBreakdown, { business: 1, enterprise: 0, unknown: 0 });
  assert.equal(pool.includedCredits, 3000);
  assert.deepEqual(pool.warnings, []);
});

test("computeIncludedCreditsPool excludes seats with no assignee or an unrecognized plan_type", () => {
  const seats = [
    { assignee: { id: 1 }, plan_type: "business" },
    { assignee: null, plan_type: "business" },
    { assignee: { id: 2 }, plan_type: "unknown" },
  ];

  const pool = computeIncludedCreditsPool(seats, { year: 2026, month: 7 });

  assert.deepEqual(pool.seatBreakdown, { business: 1, enterprise: 0, unknown: 2 });
  assert.equal(pool.includedCredits, 3000);
  assert.equal(pool.warnings.length, 1);
  assert.match(pool.warnings[0], /2 seat\(s\) have no assignee or an unrecognized plan_type/);
});

test("computeIncludedCreditsPool warns on conflicting plan_type for the same assignee", () => {
  const seats = [
    { assignee: { id: 7 }, plan_type: "business" },
    { assignee: { id: 7 }, plan_type: "enterprise" },
  ];

  const pool = computeIncludedCreditsPool(seats, { year: 2026, month: 7 });

  assert.deepEqual(pool.seatBreakdown, { business: 1, enterprise: 0, unknown: 0 });
  assert.equal(pool.warnings.length, 1);
  assert.match(pool.warnings[0], /Assignee 7 has conflicting plan_type/);
});

test("aggregateUserMetrics labels interaction and generation percentages", () => {
  const result = aggregateUserMetrics([
    {
      day: "2026-07-01",
      user_login: "octocat",
      user_id: 1,
      ai_credits_used: 12.5,
      user_initiated_interaction_count: 10,
      code_generation_activity_count: 20,
      code_acceptance_activity_count: 5,
      totals_by_model_feature: [
        {
          model: "Model A",
          user_initiated_interaction_count: 8,
          code_generation_activity_count: 5,
          code_acceptance_activity_count: 2,
        },
        {
          model: "Model B",
          user_initiated_interaction_count: 2,
          code_generation_activity_count: 15,
          code_acceptance_activity_count: 3,
        },
      ],
    },
  ]);

  assert.equal(result[0].aiCreditsUsed, 12.5);
  assert.equal(result[0].models[0].percentageOfInteractions, 80);
  assert.equal(result[0].models[0].percentageOfCodeGenerations, 25);
});

test("aggregateUserMetrics groups renamed users by stable user_id", () => {
  const result = aggregateUserMetrics([
    {
      day: "2026-07-01",
      user_id: 42,
      user_login: "old-login",
      ai_credits_used: 2,
    },
    {
      day: "2026-07-02",
      user_id: 42,
      user_login: "new-login",
      ai_credits_used: 3,
    },
    {
      day: "2026-07-02",
      user_id: 43,
      user_login: "old-login",
      ai_credits_used: 4,
    },
  ]);

  assert.equal(result.length, 2);
  assert.equal(result.find((user) => user.userId === 42).userLogin, "new-login");
  assert.equal(result.find((user) => user.userId === 42).aiCreditsUsed, 5);
});

test("attachUserCreditUsage adds credit-based model percentages by stable ID", () => {
  const users = [{ userId: 42, userLogin: "new-login", models: [] }];
  const result = attachUserCreditUsage(users, [{
    userId: 42,
    userLogin: "new-login",
    usage: {
      usageItems: [
        {
          model: "Model A",
          grossQuantity: 30,
          discountQuantity: 30,
          netQuantity: 0,
          grossAmount: 0.3,
          netAmount: 0,
        },
        {
          model: "Model B",
          grossQuantity: 10,
          discountQuantity: 5,
          netQuantity: 5,
          grossAmount: 0.1,
          netAmount: 0.05,
        },
      ],
    },
  }]);

  assert.equal(result[0].billingCredits.grossUsed, 40);
  assert.equal(
    result[0].billingCredits.models[0].percentageOfGrossCredits,
    75,
  );
  assert.equal(result[0].billingCredits.models[1].percentageOfGrossCredits, 25);
});

test("parseArgs applies UTC defaults and requires an enterprise", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  const options = parseArgs(
    ["--enterprise", "example-enterprise"],
    now,
  );

  assert.equal(options.year, 2026);
  assert.equal(options.month, 7);
  assert.equal(options.enterprise, "example-enterprise");
  assert.equal(options.includeUsers, true);
  assert.throws(
    () => parseArgs([], now),
    /--enterprise is required/,
  );
});

test("getMonthReportDays includes completed UTC days only", () => {
  assert.deepEqual(
    getMonthReportDays(
      { year: 2026, month: 7 },
      new Date("2026-07-03T12:00:00Z"),
    ),
    ["2026-07-01", "2026-07-02"],
  );
  assert.equal(
    getMonthReportDays(
      { year: 2026, month: 6 },
      new Date("2026-07-03T12:00:00Z"),
    ).length,
    30,
  );
  assert.deepEqual(
    getMonthReportDays(
      { year: 2026, month: 8 },
      new Date("2026-07-03T12:00:00Z"),
    ),
    [],
  );
});

test("buildReport aggregates daily user records for the month", async () => {
  const client = {
    getCreditUsage: async () => ({
      timePeriod: { year: 2026, month: 7 },
      usageItems: [{
        model: "Model A",
        grossQuantity: 25,
        discountQuantity: 25,
        netQuantity: 0,
        grossAmount: 0.25,
        netAmount: 0,
      }],
    }),
    getBudgets: async () => [],
    getCopilotSeats: async () => ({
      totalSeats: 1,
      seats: [{ assignee: { id: 101 }, plan_type: "business" }],
    }),
    getMonthUserReports: async ({ days }) => ({
      coverage: {
        latest28Day: {
          reportStartDay: "2026-06-06",
          reportEndDay: "2026-07-03",
        },
        targetDays: days.length,
        coveredByLatest28Day: days.length,
        dailyReportsRequested: 0,
        dailyReportsWithContent: 0,
        noContentDays: [],
      },
      records: [
        {
          day: "2026-07-01",
          user_login: "octocat",
          user_id: 1,
          ai_credits_used: 10,
          user_initiated_interaction_count: 2,
        },
        {
          day: "2026-07-02",
          user_login: "octocat",
          user_id: 1,
          ai_credits_used: 15,
          user_initiated_interaction_count: 3,
        },
      ],
    }),
    getUserCreditUsageReports: async ({ users }) => ({
      reports: [{
        userId: users[0].userId,
        userLogin: users[0].userLogin,
        usage: {
          usageItems: [{
            model: "Model A",
            grossQuantity: 20,
            discountQuantity: 20,
            netQuantity: 0,
            grossAmount: 0.2,
            netAmount: 0,
          }],
        },
      }],
      failures: [],
    }),
  };
  const report = await buildReport(
    {
      enterprise: "example-enterprise",
      year: 2026,
      month: 7,
      includeUsers: true,
      now: new Date("2026-07-03T12:00:00Z"),
    },
    client,
  );

  assert.equal(report.userMetrics.period.startDay, "2026-07-01");
  assert.equal(report.userMetrics.period.endDay, "2026-07-02");
  assert.equal(report.userMetrics.period.coveredByLatest28Day, 2);
  assert.equal(report.userMetrics.period.dailyReportsRequested, 0);
  assert.deepEqual(report.userMetrics.period.noContentDays, []);
  assert.equal(report.userMetrics.summary.analyticsCreditsUsed, 25);
  assert.equal(report.userMetrics.summary.expectedToReconcileWithBilling, false);
  assert.equal(report.userMetrics.users[0].aiCreditsUsed, 25);
  assert.equal(report.userMetrics.users[0].userInitiatedInteractions, 5);
  assert.equal(report.userMetrics.users[0].billingCredits.grossUsed, 20);
  assert.equal(
    report.userMetrics.users[0].billingCredits.models[0]
      .percentageOfGrossCredits,
    100,
  );
  assert.equal(report.userMetrics.summary.billingBreakdown.successfulUserCount, 1);
  assert.equal(report.userMetrics.summary.billingBreakdown.complete, true);
  assert.equal(report.userMetrics.summary.billingBreakdown.unattributedGrossCredits, 5);
  assert.deepEqual(report.userMetrics.billingFailures, []);

  // July 2026 falls inside the temporary promo window, so the single
  // business seat is worth 3,000 credits rather than the standard 1,900.
  assert.equal(report.limits.includedCredits, 3000);
  assert.equal(report.limits.effectiveLimit, 3000);
  assert.equal(report.limits.percentUsed, 0.8333);
  assert.equal(report.limits.includedCreditsBasis.promoActive, true);
  assert.deepEqual(report.copilot.seatBreakdown, {
    business: 1,
    enterprise: 0,
    unknown: 0,
  });
});

test("buildReport emits the same normalized enterprise shape", async () => {
  const client = {
    getCreditUsage: async () => ({
      timePeriod: { year: 2026, month: 7 },
      usageItems: [],
    }),
    getBudgets: async () => [],
    getCopilotSeats: async () => ({ totalSeats: 10, seats: [{}, {}] }),
  };
  const report = await buildReport(
    {
      enterprise: "example-enterprise",
      year: 2026,
      month: 7,
      includeUsers: false,
    },
    client,
  );

  assert.deepEqual(report.scope, {
    type: "enterprise",
    slug: "example-enterprise",
  });
  assert.equal(report.copilot.totalSeats, 10);
  assert.equal(report.copilot.assignmentRecordCount, 2);
  assert.equal(report.userMetrics, null);

  // Seats with no assignee can't be attributed to a plan, so they fall
  // into `unknown` and contribute nothing to the included-credit total.
  assert.equal(report.limits.includedCredits, 0);
  assert.deepEqual(report.copilot.seatBreakdown, {
    business: 0,
    enterprise: 0,
    unknown: 2,
  });
});
