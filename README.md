# Copilot usage report

Dependency-free Node CLI for collecting GitHub Copilot billing and usage data.
Of course Github has to make a really weird API for getting your data. You can
get the last 28 days in a report or a specific day in a response. So this tool
stiches together their hodgepodge API into a payload that's the month-to-date data.

## Local usage

```bash
GITHUB_TOKEN="$(gh auth token)" node src/copilot-usage.mjs \
  --enterprise ENTERPRISE_SLUG \
  --pretty
```

All GitHub API requests use enterprise endpoints. The token owner must have the
required enterprise billing, Copilot metrics, and Copilot seat permissions.

By default, the CLI downloads the latest rolling 28-day user report, keeps only
records whose `day` belongs to the selected month, and requests individual daily
reports only for target dates outside the rolling window. It then aggregates the
records into month-to-date user totals. The current UTC day is excluded because
GitHub only publishes reports for completed days.

Fetch one day instead for diagnostics:

```bash
GITHUB_TOKEN="$(gh auth token)" node src/copilot-usage.mjs \
  --enterprise ENTERPRISE_SLUG \
  --user-report-day 2026-07-25 \
  --pretty
```

Redirect stdout when a file is useful:

```bash
GITHUB_TOKEN="$(gh auth token)" node src/copilot-usage.mjs \
  --enterprise ENTERPRISE_SLUG > copilot-usage.json
```

The enterprise seat API can return more assignment records than unique billed
seats when a user receives Copilot through multiple organizations or enterprise
teams. `copilot.totalSeats` is GitHub's unique billed-seat count, while
`copilot.assignmentRecordCount` is the number of returned assignment records.

## Output objects

The report is a single JSON object with these top-level keys:

| Key | Type | Description |
| --- | --- | --- |
| `period` | object | The billing year/month the report covers: `{ year, month }`. |
| `credits` | object | Month-to-date AI-credit consumption totals (gross, discounted, net, and USD) for the whole scope. |
| `limits` | object | The included-credit pool, computed effective limit, percent used, and any admin-configured spending budgets. |
| `copilot` | object | Seat counts and seat-plan breakdown backing the `limits` calculation. |
| `models` | array | Per-model credit breakdown for the whole scope, sorted by usage descending. |
| `dailyUsage` | object | Day-indexed credit series, split by model and by user, for charting usage over the month. |
| `userMetrics` | object \| null | Per-user month-to-date usage and billing breakdown; `null` when `--no-users` is set. |

## Tests

```bash
npm test
```
