import { createInterface } from "node:readline";
import { Readable } from "node:stream";

export const API_VERSION = "2026-03-10";

export class GitHubApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function isIsoDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDownloadLinks(value, reportType) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${reportType} response has no download links`);
  }

  for (const valueUrl of value) {
    let url;
    try {
      url = new URL(valueUrl);
    } catch {
      throw new Error(`${reportType} response has an invalid download link`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`${reportType} download link must use HTTPS`);
    }
  }
  return value;
}

export function validateDailyUserReportEnvelope(report, expectedDay) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Daily user report response is invalid");
  }
  if (!isIsoDay(report.report_day) || report.report_day !== expectedDay) {
    throw new Error("Daily user report does not match the requested day");
  }
  return {
    reportDay: report.report_day,
    downloadLinks: validateDownloadLinks(
      report.download_links,
      "Daily user report",
    ),
  };
}

export function validateLatestUserReportEnvelope(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Latest 28-day user report response is invalid");
  }
  if (!isIsoDay(report.report_start_day) || !isIsoDay(report.report_end_day)) {
    throw new Error("Latest 28-day user report has an invalid date range");
  }
  if (report.report_start_day > report.report_end_day) {
    throw new Error("Latest 28-day user report starts after it ends");
  }
  return {
    reportStartDay: report.report_start_day,
    reportEndDay: report.report_end_day,
    downloadLinks: validateDownloadLinks(
      report.download_links,
      "Latest 28-day user report",
    ),
  };
}

export function validateAiCreditUsageReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Billing AI credit usage response is invalid");
  }
  if (!report.timePeriod || typeof report.timePeriod !== "object") {
    throw new Error("Billing AI credit usage response has no time period");
  }
  if (!Array.isArray(report.usageItems)) {
    throw new Error("Billing AI credit usage response has no usageItems array");
  }

  for (const item of report.usageItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Billing AI credit usage response contains an invalid item");
    }
    if (typeof item.model !== "string" || !item.model) {
      throw new Error("Billing AI credit usage item has no model");
    }
    for (const field of [
      "grossQuantity",
      "discountQuantity",
      "netQuantity",
      "grossAmount",
      "netAmount",
    ]) {
      if (typeof item[field] !== "number" || !Number.isFinite(item[field])) {
        throw new Error(`Billing AI credit usage item has invalid ${field}`);
      }
    }
  }

  return report;
}

function validateUserRecord(record, range) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("User metrics report contains an invalid record");
  }
  if (record.user_id === undefined || record.user_id === null || record.user_id === "") {
    throw new Error("User metrics record has no user_id");
  }
  if (typeof record.user_login !== "string" || !record.user_login) {
    throw new Error("User metrics record has no user_login");
  }
  if (!isIsoDay(record.day)) {
    throw new Error("User metrics record has an invalid day");
  }
  if (record.day < range.startDay || record.day > range.endDay) {
    throw new Error("User metrics record falls outside its report range");
  }
  if (
    range.kind === "latest-28-day" &&
    (record.report_start_day !== range.startDay ||
      record.report_end_day !== range.endDay)
  ) {
    throw new Error("User metrics record does not match its 28-day report range");
  }
  return record;
}

function rejectDuplicateUserDays(records) {
  const seen = new Set();
  for (const record of records) {
    const key = `${record.day}\u0000${String(record.user_id)}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate user metrics record for user_id ${record.user_id} on ${record.day}`,
      );
    }
    seen.add(key);
  }
}

export class GitHubClient {
  constructor({ token, apiBaseUrl = "https://api.github.com", fetchImpl = fetch }) {
    if (!token) {
      throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
    }

    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async request(path) {
    const url = new URL(path, `${this.apiBaseUrl}/`);
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "copilot-usage-report",
        "X-GitHub-Api-Version": API_VERSION,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GitHubApiError(
        `GitHub API request failed with HTTP ${response.status}`,
        { status: response.status, url: url.toString(), body },
      );
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async getCreditUsage({ enterprise, year, month, day, user }) {
    const query = new URLSearchParams({
      year: String(year),
      month: String(month),
    });
    if (day) {
      query.set("day", String(day));
    }
    if (user) {
      query.set("user", user);
    }
    const report = await this.request(
      `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/ai_credit/usage?${query}`,
    );
    return validateAiCreditUsageReport(report);
  }

  async getDailyCreditUsageReports({
    enterprise,
    year,
    month,
    days,
    concurrency = 5,
  }) {
    const outcomes = new Array(days.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < days.length) {
        const index = nextIndex;
        nextIndex += 1;
        const day = days[index];

        try {
          const usage = await this.getCreditUsage({
            enterprise,
            year,
            month,
            day: Number(day.slice(-2)),
          });
          outcomes[index] = { ok: true, day, usage };
        } catch (error) {
          outcomes[index] = {
            ok: false,
            day,
            status: Number.isInteger(error?.status) ? error.status : null,
            message: error?.message || String(error),
          };
        }
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), days.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      reports: outcomes
        .filter((outcome) => outcome.ok)
        .map(({ ok, ...outcome }) => outcome),
      failures: outcomes
        .filter((outcome) => !outcome.ok)
        .map(({ ok, ...outcome }) => outcome),
    };
  }

  async getUserCreditUsageReports({
    enterprise,
    year,
    month,
    users,
    concurrency = 5,
  }) {
    const outcomes = new Array(users.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < users.length) {
        const index = nextIndex;
        nextIndex += 1;
        const user = users[index];

        try {
          const usage = await this.getCreditUsage({
            enterprise,
            year,
            month,
            user: user.userLogin,
          });
          outcomes[index] = {
            ok: true,
            userId: user.userId,
            userLogin: user.userLogin,
            usage,
          };
        } catch (error) {
          outcomes[index] = {
            ok: false,
            userId: user.userId,
            userLogin: user.userLogin,
            status: Number.isInteger(error?.status) ? error.status : null,
            message: error?.message || String(error),
          };
        }
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), users.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      reports: outcomes
        .filter((outcome) => outcome.ok)
        .map(({ ok, ...outcome }) => outcome),
      failures: outcomes
        .filter((outcome) => !outcome.ok)
        .map(({ ok, ...outcome }) => outcome),
    };
  }

  async getBudgets({ enterprise }) {
    const budgets = [];
    let page = 1;

    while (true) {
      const response = await this.request(
        `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets?per_page=100&page=${page}`,
      );
      budgets.push(...(response?.budgets ?? []));

      if (!response?.has_next_page) {
        return budgets;
      }
      page += 1;
    }
  }

  async getCopilotSeats({ enterprise }) {
    const seats = [];
    let page = 1;
    let totalSeats = 0;

    while (true) {
      const response = await this.request(
        `/enterprises/${encodeURIComponent(enterprise)}/copilot/billing/seats?per_page=100&page=${page}`,
      );
      const pageSeats = response?.seats ?? [];
      totalSeats = response?.total_seats ?? totalSeats;
      seats.push(...pageSeats);

      if (pageSeats.length < 100) {
        return { totalSeats, seats };
      }
      page += 1;
    }
  }

  async getUserReport({ enterprise, day }) {
    const query = new URLSearchParams({ day });
    const report = await this.request(
      `/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics/reports/users-1-day?${query}`,
    );

    if (!report) {
      return { reportDay: day, available: false, records: [] };
    }

    const envelope = validateDailyUserReportEnvelope(report, day);
    const records = [];
    for (const downloadUrl of envelope.downloadLinks) {
      for await (const record of readNdjson(downloadUrl, this.fetchImpl)) {
        records.push(validateUserRecord(record, {
          kind: "daily",
          startDay: day,
          endDay: day,
        }));
      }
    }
    rejectDuplicateUserDays(records);

    return {
      reportDay: envelope.reportDay,
      available: true,
      records,
    };
  }

  async getLatestUserReport({ enterprise }) {
    const report = await this.request(
      `/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics/reports/users-28-day/latest`,
    );
    const envelope = validateLatestUserReportEnvelope(report);
    const records = [];

    for (const downloadUrl of envelope.downloadLinks) {
      for await (const record of readNdjson(downloadUrl, this.fetchImpl)) {
        records.push(validateUserRecord(record, {
          kind: "latest-28-day",
          startDay: envelope.reportStartDay,
          endDay: envelope.reportEndDay,
        }));
      }
    }
    rejectDuplicateUserDays(records);

    return {
      ...envelope,
      records,
    };
  }

  async getUserReports({ enterprise, days, concurrency = 5 }) {
    const reports = new Array(days.length);
    let nextIndex = 0;

    // TODO: Allow callers to load and persist daily report aggregates (for
    // example, in S3 from GitHub Actions) so recurring month-to-date runs only
    // download days that have not already been collected.
    const worker = async () => {
      while (nextIndex < days.length) {
        const index = nextIndex;
        nextIndex += 1;
        reports[index] = await this.getUserReport({
          enterprise,
          day: days[index],
        });
      }
    };

    const workerCount = Math.min(concurrency, days.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      reports,
      records: reports.flatMap((report) => report.records),
    };
  }

  async getMonthUserReports({ enterprise, days }) {
    if (days.length === 0) {
      return {
        records: [],
        coverage: {
          latest28Day: null,
          targetDays: 0,
          coveredByLatest28Day: 0,
          dailyReportsRequested: 0,
          dailyReportsWithContent: 0,
          noContentDays: [],
        },
      };
    }

    const latest = await this.getLatestUserReport({ enterprise });
    const targetDays = new Set(days);
    const coveredDays = days.filter(
      (day) => day >= latest.reportStartDay && day <= latest.reportEndDay,
    );
    const dailyDays = days.filter(
      (day) => day < latest.reportStartDay || day > latest.reportEndDay,
    );
    const daily = await this.getUserReports({ enterprise, days: dailyDays });
    const records = [
      ...latest.records.filter((record) => targetDays.has(record.day)),
      ...daily.records,
    ];
    rejectDuplicateUserDays(records);

    return {
      records,
      coverage: {
        latest28Day: {
          reportStartDay: latest.reportStartDay,
          reportEndDay: latest.reportEndDay,
        },
        targetDays: days.length,
        coveredByLatest28Day: coveredDays.length,
        dailyReportsRequested: daily.reports.length,
        dailyReportsWithContent: daily.reports.filter((report) => report.available)
          .length,
        noContentDays: daily.reports
          .filter((report) => !report.available)
          .map((report) => report.reportDay),
      },
    };
  }
}

export async function* readNdjson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "copilot-usage-report" },
  });

  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub report download failed with HTTP ${response.status}`,
      { status: response.status, url },
    );
  }

  if (!response.body) {
    return;
  }

  const lines = createInterface({
    input: Readable.fromWeb(response.body),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }

    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON at line ${lineNumber}: ${error.message}`);
    }
  }
}
