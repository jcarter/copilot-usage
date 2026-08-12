# Copilot usage report

Dependency-free Node CLI for collecting GitHub Copilot billing and usage data.
The command writes exactly one JSON document to stdout. Errors and diagnostics
are written to stderr so stdout can be redirected safely.

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

## Output semantics

- `credits.grossUsed` is month-to-date AI-credit consumption.
- `models[].percentageOfGrossCredits` is a credit-based model percentage from
  the billing API.
- `userMetrics.users[].aiCreditsUsed` is the user's aggregated total across the
  reports with content in `userMetrics.period`.
- `userMetrics.users[].billingCredits` is fetched from the billing API by
  filtering the selected enterprise month by that user's current login. Its
  `models[].grossCredits` and
  `models[].percentageOfGrossCredits` fields provide the credit-based per-model
  breakdown. Results are attached to the stable usage-metrics `userId`.
- `userMetrics.summary.analyticsCreditsUsed` is an analytics total, not a
  billing total. GitHub does not expect it to reconcile exactly with
  `credits.grossUsed`, and the output reports the observed difference rather
  than hiding it.
- `userMetrics.period.noContentDays` lists dates for which GitHub returned HTTP
  204 instead of a downloadable user report.
- `userMetrics.users[].models` remains the activity-based model breakdown from
  Copilot usage metrics. GitHub does not put model-level credits in that report,
  so the separate `billingCredits.models` breakdown comes from one filtered
  billing request per reported user.
- `userMetrics.billingFailures` lists user billing requests that did not
  succeed. `userMetrics.summary.billingBreakdown` reports request completeness,
  attributed gross credits, and the residual `unattributedGrossCredits` versus
  the scope-level billing total so partial coverage cannot silently undercount.
- `limits.includedCredits` and `limits.effectiveLimit` are **computed, not
  fetched** — no GitHub API exposes the enterprise's total included AI-credit
  pool. GitHub grants a fixed monthly credit allotment per licensed seat,
  keyed by `plan_type` (`business`/`enterprise`), pooled at the enterprise
  level; this matches that dashboard figure by multiplying each plan's unique
  seat count (deduplicated by assignee the same way as `copilot.totalSeats`,
  see above) by a hardcoded per-plan rate. Those rates live in
  `src/aggregate.mjs` (`STANDARD_CREDITS_PER_SEAT` / `PROMO_CREDITS_PER_SEAT`)
  and mirror GitHub's currently published pricing, including a temporary
  promotional boost for existing customers from 2026-06-01 through 2026-09-01.
  **They will silently go stale** if GitHub changes plan pricing or the promo
  window closes without a matching code update — `limits.includedCreditsBasis`
  reports which rate table and promo state were used for the report's period,
  plus any warnings (seats with no assignee, an unrecognized `plan_type`, or
  conflicting `plan_type` values for the same user across duplicate seat
  records) so a wrong total is visible rather than silent.
- `limits.percentUsed` is `credits.grossUsed` against `limits.includedCredits`,
  matching the dashboard's usage progress bar.
- `limits.effectiveLimit` currently mirrors `limits.includedCredits`. It does
  not subtract any admin-configured spending budget that could lower the real
  ceiling further — `limits.aiCreditBudgets` lists those separately (note
  their `scope`: a budget scoped below "enterprise" caps only part of the
  pool) for manual cross-referencing.
- `copilot.seatBreakdown` reports unique licensed-seat counts by `plan_type`
  (`business`/`enterprise`/`unknown`), the same seat data `limits.includedCredits`
  is derived from.

Month-to-date reports are currently recalculated on each run, although the
rolling report substantially reduces API calls. A `TODO` in the report-fetching
code marks the intended extension point for persisting daily aggregates in S3
(or another store) so GitHub Actions can fetch only missing days.

## Tests

```bash
npm test
```
