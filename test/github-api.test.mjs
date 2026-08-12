import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubApiError,
  GitHubClient,
  readNdjson,
  validateAiCreditUsageReport,
  validateDailyUserReportEnvelope,
  validateLatestUserReportEnvelope,
} from "../src/github-api.mjs";

function creditUsageResponse(items = []) {
  return {
    timePeriod: { year: 2026, month: 7 },
    usageItems: items,
  };
}

test("readNdjson parses records and ignores blank lines", async () => {
  const body = [
    JSON.stringify({ user_login: "first", ai_credits_used: 1 }),
    "",
    JSON.stringify({ user_login: "second", ai_credits_used: 2 }),
  ].join("\n");
  const url = `data:application/x-ndjson,${encodeURIComponent(body)}`;
  const records = [];

  for await (const record of readNdjson(url)) {
    records.push(record);
  }

  assert.deepEqual(records, [
    { user_login: "first", ai_credits_used: 1 },
    { user_login: "second", ai_credits_used: 2 },
  ]);
});

test("readNdjson reports invalid line numbers", async () => {
  const url = "data:application/x-ndjson,%7B%22valid%22%3Atrue%7D%0Anot-json";

  await assert.rejects(async () => {
    for await (const record of readNdjson(url)) {
      void record;
    }
  }, /Invalid NDJSON at line 2/);
});

test("daily report envelopes require the requested day and download links", () => {
  assert.throws(
    () => validateDailyUserReportEnvelope({
      report_day: "2026-07-01",
      download_links: ["https://downloads.example/report.ndjson"],
    }, "2026-07-02"),
    /does not match the requested day/,
  );
  assert.throws(
    () => validateDailyUserReportEnvelope({
      report_day: "2026-07-02",
      download_links: [],
    }, "2026-07-02"),
    /has no download links/,
  );
});

test("latest report envelopes require a valid ordered range", () => {
  assert.throws(
    () => validateLatestUserReportEnvelope({
      report_start_day: "2026-07-03",
      report_end_day: "2026-07-02",
      download_links: ["https://downloads.example/report.ndjson"],
    }),
    /starts after it ends/,
  );
});

test("AI credit usage reports require a valid envelope and model quantities", () => {
  assert.throws(
    () => validateAiCreditUsageReport({ timePeriod: {}, usageItems: null }),
    /no usageItems array/,
  );
  assert.throws(
    () => validateAiCreditUsageReport(creditUsageResponse([{
      model: "Model A",
      grossQuantity: "10",
    }])),
    /invalid grossQuantity/,
  );
});

test("getCreditUsage passes the user filter to the enterprise endpoint", async () => {
  const requestedUrls = [];
  const client = new GitHubClient({
    token: "test-token",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify(creditUsageResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.getCreditUsage({
    enterprise: "example-enterprise",
    year: 2026,
    month: 7,
    user: "renamed-user",
  });

  assert.equal(requestedUrls[0].pathname,
    "/enterprises/example-enterprise/settings/billing/ai_credit/usage");
  assert.equal(requestedUrls[0].searchParams.get("user"), "renamed-user");
  assert.equal(requestedUrls[0].searchParams.get("year"), "2026");
  assert.equal(requestedUrls[0].searchParams.get("month"), "7");
});

test("getCreditUsage passes the day filter to the enterprise endpoint", async () => {
  const requestedUrls = [];
  const client = new GitHubClient({
    token: "test-token",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify(creditUsageResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.getCreditUsage({
    enterprise: "example-enterprise",
    year: 2026,
    month: 7,
    day: 5,
  });

  assert.equal(requestedUrls[0].searchParams.get("day"), "5");
});

test("getDailyCreditUsageReports fetches one report per day and surfaces failures", async () => {
  const client = Object.create(GitHubClient.prototype);
  client.getCreditUsage = async ({ day }) => {
    if (day === 2) {
      throw new GitHubApiError("forbidden", { status: 403 });
    }
    return creditUsageResponse();
  };

  const result = await client.getDailyCreditUsageReports({
    enterprise: "example-enterprise",
    year: 2026,
    month: 7,
    days: ["2026-07-01", "2026-07-02", "2026-07-03"],
  });

  assert.deepEqual(result.reports.map((report) => report.day), [
    "2026-07-01",
    "2026-07-03",
  ]);
  assert.deepEqual(result.failures, [{
    day: "2026-07-02",
    status: 403,
    message: "forbidden",
  }]);
});

test("per-user credit reports preserve stable IDs and surface failures", async () => {
  const client = Object.create(GitHubClient.prototype);
  client.getCreditUsage = async ({ user }) => {
    if (user === "failed-user") {
      throw new GitHubApiError("forbidden", { status: 403 });
    }
    return creditUsageResponse();
  };

  const result = await client.getUserCreditUsageReports({
    enterprise: "example-enterprise",
    year: 2026,
    month: 7,
    users: [
      { userId: 42, userLogin: "renamed-user" },
      { userId: 43, userLogin: "failed-user" },
    ],
  });

  assert.deepEqual(result.reports.map((report) => report.userId), [42]);
  assert.deepEqual(result.failures, [{
    userId: 43,
    userLogin: "failed-user",
    status: 403,
    message: "forbidden",
  }]);
});

test("month reports use the rolling report and fetch only uncovered days", async () => {
  const client = Object.create(GitHubClient.prototype);
  const requestedDailyDays = [];
  client.getLatestUserReport = async () => ({
    reportStartDay: "2026-07-02",
    reportEndDay: "2026-07-03",
    records: [
      { day: "2026-07-02", user_id: 1, user_login: "one" },
      { day: "2026-07-03", user_id: 1, user_login: "one" },
      { day: "2026-06-30", user_id: 2, user_login: "outside" },
    ],
  });
  client.getUserReports = async ({ days }) => {
    requestedDailyDays.push(...days);
    return {
      reports: days.map((day) => ({
        reportDay: day,
        available: true,
        records: [],
      })),
      records: [{ day: "2026-07-01", user_id: 1, user_login: "one" }],
    };
  };

  const result = await client.getMonthUserReports({
    enterprise: "example-enterprise",
    days: ["2026-07-01", "2026-07-02", "2026-07-03"],
  });

  assert.deepEqual(requestedDailyDays, ["2026-07-01"]);
  assert.deepEqual(result.records.map((record) => record.day), [
    "2026-07-02",
    "2026-07-03",
    "2026-07-01",
  ]);
  assert.equal(result.coverage.coveredByLatest28Day, 2);
  assert.equal(result.coverage.dailyReportsRequested, 1);
});

test("month reports reject duplicate user-day records across sources", async () => {
  const client = Object.create(GitHubClient.prototype);
  client.getLatestUserReport = async () => ({
    reportStartDay: "2026-07-01",
    reportEndDay: "2026-07-01",
    records: [{ day: "2026-07-01", user_id: 1, user_login: "one" }],
  });
  client.getUserReports = async () => ({
    reports: [{ reportDay: "2026-07-02", available: true, records: [] }],
    records: [{ day: "2026-07-01", user_id: 1, user_login: "one" }],
  });

  await assert.rejects(
    client.getMonthUserReports({
      enterprise: "example-enterprise",
      days: ["2026-07-01", "2026-07-02"],
    }),
    /Duplicate user metrics record/,
  );
});
