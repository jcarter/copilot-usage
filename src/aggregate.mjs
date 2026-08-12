function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function percentage(part, total) {
  if (total === 0) {
    return 0;
  }
  return Math.round((part / total) * 1_000_000) / 10_000;
}

// GitHub does not expose the enterprise-wide included AI-credit pool via any
// API. It grants a fixed monthly credit allotment per licensed seat, keyed by
// plan_type, pooled across the billing entity. Rates below mirror GitHub's
// published pricing and must be updated by hand if GitHub changes them.
// Promo window source: docs.github.com "Usage-based billing for organizations
// and enterprises" (temporary boost for existing customers, 2026-06-01
// through 2026-09-01).
const STANDARD_CREDITS_PER_SEAT = { business: 1900, enterprise: 3900 };
const PROMO_CREDITS_PER_SEAT = { business: 3000, enterprise: 7000 };

function isPromoPeriod({ year, month }) {
  return year === 2026 && month >= 6 && month <= 8;
}

export function computeIncludedCreditsPool(seats = [], period) {
  const ratesPerSeatPerMonth = isPromoPeriod(period)
    ? PROMO_CREDITS_PER_SEAT
    : STANDARD_CREDITS_PER_SEAT;

  const warnings = [];
  const planTypeByAssignee = new Map();
  let unassignedSeats = 0;

  for (const seat of seats) {
    const assigneeId = seat?.assignee?.id;
    if (assigneeId === undefined || assigneeId === null) {
      unassignedSeats += 1;
      continue;
    }

    const planType = seat.plan_type;
    if (!planTypeByAssignee.has(assigneeId)) {
      planTypeByAssignee.set(assigneeId, planType);
    } else if (planTypeByAssignee.get(assigneeId) !== planType) {
      warnings.push(
        `Assignee ${assigneeId} has conflicting plan_type values across seat records (using "${planTypeByAssignee.get(assigneeId)}")`,
      );
    }
  }

  const seatBreakdown = { business: 0, enterprise: 0, unknown: 0 };
  for (const planType of planTypeByAssignee.values()) {
    if (planType === "business" || planType === "enterprise") {
      seatBreakdown[planType] += 1;
    } else {
      seatBreakdown.unknown += 1;
    }
  }
  seatBreakdown.unknown += unassignedSeats;

  if (seatBreakdown.unknown > 0) {
    warnings.push(
      `${seatBreakdown.unknown} seat(s) have no assignee or an unrecognized plan_type and are excluded from the included-credit total`,
    );
  }

  const includedCredits =
    seatBreakdown.business * ratesPerSeatPerMonth.business +
    seatBreakdown.enterprise * ratesPerSeatPerMonth.enterprise;

  return {
    includedCredits,
    uniqueSeatCount: planTypeByAssignee.size + unassignedSeats,
    seatBreakdown,
    ratesPerSeatPerMonth,
    promoActive: isPromoPeriod(period),
    warnings,
  };
}

export function aggregateCreditUsage(usageItems = []) {
  const totals = {
    grossUsed: 0,
    discounted: 0,
    netBillable: 0,
    grossValueUsd: 0,
    netChargeUsd: 0,
  };
  const models = new Map();

  for (const item of usageItems) {
    const gross = number(item.grossQuantity);
    totals.grossUsed += gross;
    totals.discounted += number(item.discountQuantity);
    totals.netBillable += number(item.netQuantity);
    totals.grossValueUsd += number(item.grossAmount);
    totals.netChargeUsd += number(item.netAmount);

    const modelName = item.model || "Unknown";
    const model = models.get(modelName) ?? {
      model: modelName,
      grossCredits: 0,
      discountedCredits: 0,
      netBillableCredits: 0,
    };
    model.grossCredits += gross;
    model.discountedCredits += number(item.discountQuantity);
    model.netBillableCredits += number(item.netQuantity);
    models.set(modelName, model);
  }

  return {
    ...totals,
    models: [...models.values()]
      .map((model) => ({
        ...model,
        percentageOfGrossCredits: percentage(
          model.grossCredits,
          totals.grossUsed,
        ),
      }))
      .sort((a, b) => b.grossCredits - a.grossCredits),
  };
}

export function normalizeAiCreditBudgets(budgets = []) {
  return budgets
    .filter((budget) => {
      const skus = budget.budget_product_skus ?? [budget.budget_product_sku];
      return skus.includes("ai_credits");
    })
    .map((budget) => ({
      id: budget.id,
      scope: budget.budget_scope,
      entityName: budget.budget_entity_name || null,
      amountUsd: number(budget.budget_amount),
      equivalentCredits: number(budget.budget_amount) * 100,
      preventsFurtherUsage: Boolean(budget.prevent_further_usage),
    }));
}

export function aggregateUserMetrics(records = []) {
  const users = new Map();

  for (const record of records) {
    if (record.user_id === undefined || record.user_id === null || record.user_id === "") {
      throw new Error("User metrics record has no user_id");
    }
    const key = String(record.user_id);
    const user = users.get(key) ?? {
      userLogin: record.user_login,
      userId: record.user_id,
      latestObservedDay: record.day ?? null,
      aiCreditsUsed: 0,
      userInitiatedInteractions: 0,
      codeGenerations: 0,
      codeAcceptances: 0,
      usedAgent: false,
      usedChat: false,
      usedCli: false,
      usedCopilotCodingAgent: false,
      usedCopilotCloudAgent: false,
      usedCopilotApp: false,
      models: new Map(),
    };

    if (
      record.day &&
      (!user.latestObservedDay || record.day >= user.latestObservedDay)
    ) {
      user.userLogin = record.user_login;
      user.latestObservedDay = record.day;
    }

    user.aiCreditsUsed += number(record.ai_credits_used);
    user.userInitiatedInteractions += number(
      record.user_initiated_interaction_count,
    );
    user.codeGenerations += number(record.code_generation_activity_count);
    user.codeAcceptances += number(record.code_acceptance_activity_count);
    user.usedAgent ||= Boolean(record.used_agent);
    user.usedChat ||= Boolean(record.used_chat);
    user.usedCli ||= Boolean(record.used_cli);
    user.usedCopilotCodingAgent ||= Boolean(record.used_copilot_coding_agent);
    user.usedCopilotCloudAgent ||= Boolean(record.used_copilot_cloud_agent);
    user.usedCopilotApp ||= Boolean(record.used_copilot_app);

    for (const item of record.totals_by_model_feature ?? []) {
      const modelName = item.model || "Unknown";
      const model = user.models.get(modelName) ?? {
        model: modelName,
        userInitiatedInteractions: 0,
        codeGenerations: 0,
        codeAcceptances: 0,
      };
      model.userInitiatedInteractions += number(
        item.user_initiated_interaction_count,
      );
      model.codeGenerations += number(item.code_generation_activity_count);
      model.codeAcceptances += number(item.code_acceptance_activity_count);
      user.models.set(modelName, model);
    }

    users.set(key, user);
  }

  return [...users.values()]
    .map((user) => {
      const models = [...user.models.values()]
        .map((model) => ({
          ...model,
          percentageOfInteractions: percentage(
            model.userInitiatedInteractions,
            user.userInitiatedInteractions,
          ),
          percentageOfCodeGenerations: percentage(
            model.codeGenerations,
            user.codeGenerations,
          ),
        }))
        .sort((a, b) =>
          b.userInitiatedInteractions - a.userInitiatedInteractions ||
          b.codeGenerations - a.codeGenerations,
        );

      return {
        ...user,
        models,
      };
    })
    .map(({ models: normalizedModels, latestObservedDay, ...user }) => ({
      ...user,
      models: normalizedModels,
    }))
    .sort((a, b) => b.aiCreditsUsed - a.aiCreditsUsed);
}

export function attachUserCreditUsage(users, reports = []) {
  const reportsByUserId = new Map();

  for (const report of reports) {
    const key = String(report.userId);
    if (reportsByUserId.has(key)) {
      throw new Error(`Duplicate billing report for user_id ${report.userId}`);
    }
    reportsByUserId.set(key, aggregateCreditUsage(report.usage?.usageItems));
  }

  return users.map((user) => {
    const credits = reportsByUserId.get(String(user.userId));
    return {
      ...user,
      billingCredits: credits
        ? {
            grossUsed: credits.grossUsed,
            discounted: credits.discounted,
            netBillable: credits.netBillable,
            grossValueUsd: credits.grossValueUsd,
            netChargeUsd: credits.netChargeUsd,
            models: credits.models,
          }
        : null,
    };
  });
}
