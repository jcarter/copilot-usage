#!/usr/bin/env node

// Renders the JSON report produced by copilot-usage.mjs as a Markdown
// summary, mirroring the credit-usage dashboard tables.

function usage() {
  return `Usage:
  node src/copilot-usage.mjs --enterprise SLUG --pretty | node src/format-markdown.mjs
  node src/format-markdown.mjs REPORT.json

Options:
  --top N   Number of top organization models to show (default: 5)
  --help    Show this help
`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function formatCredits(value) {
  return Number.isFinite(value) ? String(Math.ceil(value)) : "0";
}

function formatPercentage(value) {
  return `${Number.isFinite(value) ? (Math.round(value * 10) / 10).toFixed(1) : "0.0"}%`;
}

function formatMonthDay(isoDay) {
  const [, month, day] = isoDay.split("-");
  return `${month}/${day}`;
}

function renderHeader(report) {
  const period = report.userMetrics?.period;
  if (!period?.startDay || !period?.endDay) {
    return "### Copilot Usage";
  }
  return `### Copilot Usage (${formatMonthDay(period.startDay)} - ${formatMonthDay(period.endDay)})`;
}

function renderOrganizationUse(report) {
  return [
    "##### Organization Use",
    "| Used AI Credits | Available AI Credits | Percentage Used |",
    "| --- | ---: | --- |",
    `| \`${formatCredits(report.credits.grossUsed)}\` | \`${formatCredits(report.limits.includedCredits)}\` | \`${formatPercentage(report.limits.percentUsed)}\` |`,
  ].join("\n");
}

function renderTopModelUse(report, topCount) {
  const lines = [
    "##### Top Organization Model Use",
    "| Model | Used AI Credits | Percentage Used |",
    "| --- | ---: | --- |",
  ];
  for (const model of report.models.slice(0, topCount)) {
    lines.push(
      `| \`${model.model}\` | \`${formatCredits(model.grossCredits)}\` | \`${formatPercentage(model.percentageOfGrossCredits)}\` |`,
    );
  }
  return lines.join("\n");
}

function highestUseModel(user) {
  const [topModel] = user.billingCredits?.models ?? [];
  if (!topModel) {
    return "N/A";
  }
  return `${topModel.model}: ${formatPercentage(topModel.percentageOfGrossCredits)}`;
}

function renderUserBreakdown(userMetrics) {
  const lines = [
    "##### User Breakdown",
    "| User | Used AI Credits | Highest Use Model |",
    "| --- | ---: | --- |",
  ];
  for (const user of userMetrics.users) {
    lines.push(
      `| \`${user.userLogin}\` | \`${formatCredits(user.aiCreditsUsed)}\` | \`${highestUseModel(user)}\` |`,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(report, { topCount = 5 } = {}) {
  const sections = [
    renderHeader(report),
    renderOrganizationUse(report),
    renderTopModelUse(report, topCount),
  ];
  if (report.userMetrics) {
    sections.push(renderUserBreakdown(report.userMetrics));
  }
  return sections.join("\n\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const argv = process.argv.slice(2);
  let topCount = 5;
  let file;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(usage());
      return;
    } else if (argument === "--top") {
      const value = argv[index + 1];
      index += 1;
      topCount = Number(value);
      if (!Number.isInteger(topCount) || topCount < 1) {
        throw new Error("--top must be a positive integer");
      }
    } else if (!argument.startsWith("--")) {
      file = argument;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const raw = file
    ? await (await import("node:fs/promises")).readFile(file, "utf8")
    : await readStdin();
  const report = JSON.parse(raw);
  process.stdout.write(`${renderMarkdown(report, { topCount })}\n`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    console.error(usage());
    process.exitCode = 2;
  }
}
