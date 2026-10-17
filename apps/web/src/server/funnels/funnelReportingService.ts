import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { CustomerAuth, CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { validateDefinition } from "./funnelDefinition";
import { reportRange } from "./funnelReportRange";
import { text } from "./trackingValidation";
import type { FunnelReport, FunnelReportRequest, FunnelReportAuthority, FunnelBranchReport, FunnelCampaignResult, FunnelCurrencyReport,
  FunnelObservedReference, FunnelStageReport, ReportDuration, ReportJourneyStatuses, ReportMoneyMeasure, ReportRatio, ObservedReferenceValues } from "./funnelReportingTypes";

type Tx = Prisma.TransactionClient;
type Limits = { journeys: number; transitions: number; facts: number; events: number; campaignRows: number; projectedBytes: number };
const DEFAULT_LIMITS: Limits = { journeys: 5000, transitions: 25000, facts: 20000, events: 10000, campaignRows: 25000, projectedBytes: 16 * 1024 * 1024 };
const keys = ["campaign", "utm_source", "utm_medium", "utm_campaign"] as const;
const authorities = (): Record<FunnelReportAuthority, number> => ({ PROVIDER_VERIFIED: 0, SERVER_ASSERTED: 0, USER_RECORDED: 0 });
const statuses = (): ReportJourneyStatuses => ({ ACTIVE: 0, SUCCEEDED: 0, FAILED: 0, CANCELLED: 0 });
const ratio = (numerator: number, denominator: number): ReportRatio => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const limited = <T>(rows: T[], limit: number): T[] => { if (rows.length > limit) limitError(); return rows; };
const limitError = (): never => fail("REPORT_LIMIT_EXCEEDED", 422, "This report exceeds its complete-snapshot limits. Narrow the entry interval.");
function duration(values: number[]): ReportDuration {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, meanMs: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null, minMs: n ? sorted[0] : null, maxMs: n ? sorted[n - 1] : null };
}
const millis = (value: string | number) => new Date(value).getTime();
function decimal(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,15}(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function money(value: bigint): string {
  const negative = value < 0n, absolute = negative ? -value : value, fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
const measure = (): ReportMoneyMeasure => ({ amount: "0", facts: 0, valuedFacts: 0, unvaluedFacts: 0, authorityCounts: authorities() });
type Transition = { journeyId: string; fromStageKey: string | null; toStageKey: string; ruleId: string | null; branchId: unknown;
  triggerKind: string; mode: string; reasonCode: string; recordedAt: string | number; redacted: number };
type Fact = { type: string; authority: FunnelReportAuthority; occurredAt: string | number; amount: unknown; currency: unknown };
type Observation = { subjectId: string; sourceId: string; sourceName: string; provider: string; status: string; ingestionMode: string; processingMode: string;
  authority: string | null; campaign: unknown; utm_source: unknown; utm_medium: unknown; utm_campaign: unknown };

/** Read-only accounting over one current, owned, immutable-version snapshot. */
export class FunnelReportingService {
  private readonly limits: Limits;
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date(), limits: Partial<Limits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof Limits])
      throw new Error("Report limits must be positive and cannot exceed production bounds.");
  }
  private async projected<T>(tx: Tx, query: Prisma.Sql, limit: number, budget: { bytes: number }): Promise<T[]> {
    // SQLite performs JSON extraction and measures only approved projected fields before Node receives them.
    const stats = await tx.$queryRaw<{ rows: bigint | number; bytes: bigint | number }[]>(Prisma.sql`
      SELECT count(*) AS rows, coalesce(sum(length(CAST(rowJson AS BLOB))),0) AS bytes FROM (${query} LIMIT ${limit + 1})`);
    const size = Number(stats[0].bytes); if (Number(stats[0].rows) > limit || size > budget.bytes) limitError(); budget.bytes -= size;
    return (await tx.$queryRaw<{ rowJson: string }[]>(Prisma.sql`${query} LIMIT ${limit + 1}`)).map(row => JSON.parse(row.rowJson) as T);
  }
  async report(principal: CustomerPrincipal, funnelId: string, request: FunnelReportRequest): Promise<FunnelReport> {
    await this.auth.assertSession(principal);
    return this.db.$transaction(async tx => {
      const asOf = this.now(), range = reportRange(request.from, request.to, asOf), budget = { bytes: this.limits.projectedBytes };
      if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: asOf } } })) fail("UNAUTHENTICATED", 401, "Sign in to continue.");
      const funnel = await tx.funnel.findFirst({ where: { id: funnelId, ownerId: principal.userId }, select: { id: true, name: true, environment: true, subjectKind: true, publishedVersionId: true } });
      if (!funnel) fail("NOT_FOUND", 404, "Funnel not found.");
      const versionId = request.versionId === undefined ? funnel.publishedVersionId : text(request.versionId, 128);
      if (!versionId) fail("FUNNEL_UNPUBLISHED", 409, "Publish a funnel before viewing results.");
      const version = await tx.funnelVersion.findFirst({ where: { id: versionId, funnelId, ownerId: principal.userId, environment: funnel.environment }, select: { id: true, number: true, publishedAt: true } });
      if (!version) fail("NOT_FOUND", 404, "Published funnel version not found.");
      const definitions = await this.projected<{ definition: unknown }>(tx, Prisma.sql`SELECT json_object('definition',json(definition)) AS rowJson FROM FunnelVersion WHERE id=${version.id} AND ownerId=${principal.userId}`, 1, budget);
      const definition = validateDefinition(definitions[0].definition);
      const cohortWhere = { funnelId, versionId, ownerId: principal.userId, environment: funnel.environment, startedAt: { gte: range.from, lt: range.to } };
      const journeys = limited(await tx.funnelJourney.findMany({ where: cohortWhere, orderBy: { id: "asc" }, take: this.limits.journeys + 1,
        select: { id: true, subjectId: true, currentStageKey: true, status: true, startedAt: true, endedAt: true } }), this.limits.journeys);
      const journeyIds = journeys.map(j => j.id), subjectIds = [...new Set(journeys.map(j => j.subjectId))];
      const scope = Prisma.sql`ownerId=${principal.userId} AND environment=${funnel.environment}`;
      const transitions = journeyIds.length ? await this.projected<Transition>(tx, Prisma.sql`SELECT json_object(
        'journeyId',journeyId,'fromStageKey',fromStageKey,'toStageKey',toStageKey,'ruleId',ruleId,
        'branchId',json_extract(evaluationTrace,'$.selectedBranchId'),'triggerKind',triggerKind,'mode',mode,'reasonCode',reasonCode,
        'recordedAt',recordedAt,'redacted',redactedAt IS NOT NULL) AS rowJson FROM FunnelStageTransition
        WHERE ${scope} AND journeyId IN (${Prisma.join(journeyIds)}) AND recordedAt<=${asOf} ORDER BY journeyId,sequence`, this.limits.transitions, budget) : [];
      const facts = subjectIds.length ? await this.projected<Fact>(tx, Prisma.sql`SELECT json_object('type',type,'authority',authority,'occurredAt',occurredAt,
        'amount',json_extract(attributes,'$.amount'),'currency',json_extract(attributes,'$.currency')) AS rowJson FROM TrackingFact
        WHERE ${scope} AND subjectId IN (${Prisma.join(subjectIds)}) AND type IN ('order.paid','refund.succeeded','deal.won') AND occurredAt<=${asOf} AND createdAt<=${asOf}`,
        this.limits.facts, budget) : [];
      const observations = subjectIds.length ? await this.projected<Observation>(tx, Prisma.sql`SELECT json_object(
        'subjectId',e.subjectId,'sourceId',e.sourceId,'sourceName',s.name,'provider',s.provider,'status',e.status,'ingestionMode',e.ingestionMode,'processingMode',e.processingMode,
        'authority',json_extract(e.envelope,'$.authority'),'campaign',json_extract(e.envelope,'$.properties.campaign'),
        'utm_source',json_extract(e.envelope,'$.properties.utm_source'),'utm_medium',json_extract(e.envelope,'$.properties.utm_medium'),
        'utm_campaign',json_extract(e.envelope,'$.properties.utm_campaign')) AS rowJson FROM TrackingEvent e JOIN TrackingSource s ON s.id=e.sourceId AND s.ownerId=e.ownerId AND s.environment=e.environment
        WHERE e.ownerId=${principal.userId} AND e.environment=${funnel.environment} AND e.subjectId IN (${Prisma.join(subjectIds)})
        AND e.status IN ('MATCHED','REDACTED') AND e.occurredAt<=${asOf} AND e.receivedAt<=${asOf}`, this.limits.events, budget) : [];
      const report: FunnelReport = {
        schemaVersion: 1, funnel: { id: funnel.id, name: funnel.name, environment: funnel.environment as "TEST" | "LIVE", subjectKind: funnel.subjectKind as "SALES" | "PURCHASE" | "CONTACT" | "SUBSCRIPTION" },
        version: { id: version.id, number: version.number, publishedAt: version.publishedAt.toISOString() },
        cohort: { from: range.from.toISOString(), to: range.to.toISOString(), asOf: asOf.toISOString(), basis: "JOURNEY_STARTED_AT", interval: "FROM_INCLUSIVE_TO_EXCLUSIVE", unit: "JOURNEY_CYCLE", entryPolicy: "ANY_CONFIGURED_ENTRY" },
        totals: { journeys: journeys.length, distinctSubjects: subjectIds.length, repeatCycles: journeys.length - subjectIds.length, active: 0, succeeded: 0, failed: 0, cancelled: 0,
          goalJourneys: 0, goalRate: ratio(0, journeys.length), manualEntryJourneys: 0, journeysWithManualChanges: 0, timeToFirstGoal: duration([]) },
        stages: [], branches: [], goals: [],
        money: { basis: "DISTINCT_COHORT_SUBJECT_FACTS", factWindow: { from: range.from.toISOString(), to: asOf.toISOString(), interval: "BOTH_INCLUSIVE" },
          pipelineValue: { available: false, reason: "NO_OPPORTUNITY_VALUE_MODEL" }, currencies: [], includedFacts: 0, valuedFacts: 0, unvaluedFacts: 0,
          missingOrInvalidCurrencyFacts: 0, excludedBeforeWindowFacts: 0, authorityCounts: authorities() },
        attribution: { model: "OBSERVED_REFERENCES", keys: [...keys], evidenceBasis: "RETAINED_MATCHED_SUBJECT_HISTORY_THROUGH_AS_OF", taggedSubjects: 0, unknownSubjects: subjectIds.length,
          partialSubjects: 0, partialBasis: "NO_COMPLETE_RETAINED_UTM_TUPLE", multiReferenceSubjects: 0, retainedMatchedEvents: 0, redactedEvents: 0, references: [], nonAdditive: true, revenueCredit: "NONE" },
        campaigns: { configuredLinks: [], results: [], uniqueMemberships: 0, uniqueAttributedSends: 0, nonAdditiveAcrossReports: true, associationBasis: "EXPLICIT_MEMBERSHIP_REASON_AND_SEND_ATTRIBUTION" },
        coverage: { transitionRows: transitions.length, stageEntryTransitions: 0, manualTransitions: 0, cancellationCommands: 0, historyModeTransitions: 0, redactedTraceTransitions: 0,
          journeysWithMissingEntryHistory: 0, invalidDurationIntervals: 0, matchedEvidenceByIngestionMode: {}, matchedEvidenceByProcessingMode: {}, unknownCampaignSubjects: subjectIds.length,
          factProvenance: authorities(), dataBasis: "PERSISTED_EVIDENCE_NOT_LIVE_INSTALLATION_VERIFICATION", completeWithinLimits: true },
      };
      const stages = new Map(definition.stages.map(stage => [stage.id, { result: { stageId: stage.id, name: stage.name, entry: definition.entryStages.includes(stage.id), goal: stage.goal, terminal: stage.terminal,
        everReachedJourneys: 0, reachRate: ratio(0, journeys.length), currentJourneys: 0, activeJourneys: 0, currentByStatus: statuses(), entryJourneys: 0, manualEntryJourneys: 0,
        visits: 0, manualVisits: 0, movedOnJourneys: 0, knownExitJourneys: 0, completedResidence: duration([]), openResidence: duration([]) } satisfies FunnelStageReport,
        reached: new Set<string>(), movedOn: new Set<string>(), completed: [] as number[], open: [] as number[], goalTimes: [] as number[] }]));
      const branches = new Map<string, { result: FunnelBranchReport; journeys: Set<string> }>(), goalTimes: number[] = [];
      const byJourney = new Map<string, Transition[]>();
      for (const t of transitions) { const list = byJourney.get(t.journeyId) ?? []; list.push(t); byJourney.set(t.journeyId, list); }
      const interval = (values: number[], start: number, end: number) => { const elapsed = end - start; if (!Number.isFinite(elapsed) || elapsed < 0) report.coverage.invalidDurationIntervals++; else values.push(elapsed); };
      for (const journey of journeys) {
        const state = journey.status as keyof ReportJourneyStatuses;
        report.totals[({ ACTIVE: "active", SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled" } as const)[state]]++;
        const current = stages.get(journey.currentStageKey)!; current.result.currentJourneys++; current.result.currentByStatus[state]++;
        if (state === "ACTIVE") current.result.activeJourneys++;
        if (state === "FAILED" || state === "CANCELLED") current.result.knownExitJourneys++;
        const all = byJourney.get(journey.id) ?? [], visits = all.filter(t => t.reasonCode !== "JOURNEY_CANCELLED"), reachedGoals = new Set<string>();
        report.coverage.cancellationCommands += all.length - visits.length; report.coverage.stageEntryTransitions += visits.length;
        report.coverage.redactedTraceTransitions += all.filter(t => t.redacted).length;
        if (!visits.length || visits[0].fromStageKey !== null) report.coverage.journeysWithMissingEntryHistory++;
        if (visits.some(t => t.triggerKind === "MANUAL")) report.totals.journeysWithManualChanges++;
        for (let index = 0; index < visits.length; index++) {
          const t = visits[index], stage = stages.get(t.toStageKey)!; stage.reached.add(journey.id); stage.result.visits++;
          if (t.triggerKind === "MANUAL") { stage.result.manualVisits++; report.coverage.manualTransitions++; }
          else if (t.mode !== "LIVE") report.coverage.historyModeTransitions++;
          if (index === 0 && t.fromStageKey === null) { stage.result.entryJourneys++; if (t.triggerKind === "MANUAL") { stage.result.manualEntryJourneys++; report.totals.manualEntryJourneys++; } }
          if (t.fromStageKey && t.fromStageKey !== t.toStageKey) stages.get(t.fromStageKey)?.movedOn.add(journey.id);
          if (stage.result.goal && !reachedGoals.has(t.toStageKey)) {
            interval(stage.goalTimes, journey.startedAt.getTime(), millis(t.recordedAt));
            if (!reachedGoals.size) interval(goalTimes, journey.startedAt.getTime(), millis(t.recordedAt)); reachedGoals.add(t.toStageKey);
          }
          const next = visits[index + 1];
          if (next) interval(stage.completed, millis(t.recordedAt), millis(next.recordedAt));
          else if (journey.endedAt) interval(stage.completed, millis(t.recordedAt), journey.endedAt.getTime());
          else if (state === "ACTIVE") interval(stage.open, millis(t.recordedAt), asOf.getTime());
          const route = definition.routes.find(r => r.id === t.ruleId && r.from === t.fromStageKey);
          const selected = !t.redacted && typeof t.branchId === "string" ? route?.branches.find(b => b.id === t.branchId && b.to === t.toStageKey) : undefined;
          const kind: FunnelBranchReport["kind"] = t.triggerKind === "MANUAL" ? "MANUAL" : selected ? "AUTOMATIC_BRANCH" : t.reasonCode === "FALLBACK_MOVE" ? "AUTOMATIC_FALLBACK" : "AUTOMATIC_UNKNOWN_BRANCH";
          const key = JSON.stringify([kind, t.ruleId, selected?.id ?? null, t.fromStageKey, t.toStageKey]);
          let branch = branches.get(key); if (!branch) { branch = { result: { kind, ruleId: t.ruleId, branchId: selected?.id ?? null, fromStageId: t.fromStageKey, toStageId: t.toStageKey,
            journeys: 0, transitions: 0, progression: ratio(0, 0), denominatorBasis: t.fromStageKey ? "SOURCE_STAGE_REACHED" : "ALL_COHORT_JOURNEYS" }, journeys: new Set() }; branches.set(key, branch); }
          branch.journeys.add(journey.id); branch.result.transitions++;
        }
        if (reachedGoals.size) report.totals.goalJourneys++;
      }
      report.stages = [...stages.values()].map(s => ({ ...s.result, everReachedJourneys: s.reached.size, reachRate: ratio(s.reached.size, journeys.length), movedOnJourneys: s.movedOn.size,
        completedResidence: duration(s.completed), openResidence: duration(s.open) }));
      report.branches = [...branches.values()].map(b => ({ ...b.result, journeys: b.journeys.size, progression: ratio(b.journeys.size, b.result.fromStageId ? stages.get(b.result.fromStageId)!.reached.size : journeys.length) }));
      report.goals = [...stages.values()].filter(s => s.result.goal).map(s => ({ stageId: s.result.stageId, name: s.result.name, journeys: s.reached.size, conversion: ratio(s.reached.size, journeys.length), timeToFirstReach: duration(s.goalTimes) }));
      report.totals.goalRate = ratio(report.totals.goalJourneys, journeys.length); report.totals.timeToFirstGoal = duration(goalTimes);
      this.aggregateMoney(report, facts, range.from);
      this.aggregateReferences(report, observations, subjectIds.length);
      await this.campaigns(tx, report, journeyIds, asOf, principal.userId);
      return report;
    });
  }
  private aggregateMoney(report: FunnelReport, facts: Fact[], from: Date) {
    const currencies = new Map<string, { result: FunnelCurrencyReport; sums: Record<"grossPaid" | "successfulRefunds" | "recordedWonValue", bigint> }>();
    for (const fact of facts) {
      if (millis(fact.occurredAt) < from.getTime()) { report.money.excludedBeforeWindowFacts++; continue; }
      report.money.includedFacts++; increment(report.money.authorityCounts, fact.authority);
      const currency = typeof fact.currency === "string" && /^[A-Z]{3}$/.test(fact.currency) ? fact.currency : null, amount = decimal(fact.amount);
      if (currency === null || amount === null) report.money.unvaluedFacts++; else report.money.valuedFacts++;
      if (!currency) { report.money.missingOrInvalidCurrencyFacts++; continue; }
      let bucket = currencies.get(currency); if (!bucket) { bucket = { result: { currency, grossPaid: measure(), successfulRefunds: measure(), recordedWonValue: measure(), netObservedCash: "0" }, sums: { grossPaid: 0n, successfulRefunds: 0n, recordedWonValue: 0n } }; currencies.set(currency, bucket); }
      const key = fact.type === "order.paid" ? "grossPaid" : fact.type === "refund.succeeded" ? "successfulRefunds" : "recordedWonValue", value = bucket.result[key];
      value.facts++; increment(value.authorityCounts, fact.authority);
      if (amount === null) value.unvaluedFacts++; else { value.valuedFacts++; bucket.sums[key] += amount; }
    }
    report.money.currencies = [...currencies.values()].sort((a, b) => a.result.currency.localeCompare(b.result.currency)).map(({ result, sums }) => {
      for (const key of ["grossPaid", "successfulRefunds", "recordedWonValue"] as const) result[key].amount = money(sums[key]);
      result.netObservedCash = money(sums.grossPaid - sums.successfulRefunds); return result;
    });
    report.coverage.factProvenance = { ...report.money.authorityCounts };
  }
  private aggregateReferences(report: FunnelReport, observations: Observation[], totalSubjects: number) {
    const groups = new Map<string, { result: FunnelObservedReference; subjects: Set<string> }>(), subjectReferences = new Map<string, Set<string>>(), complete = new Set<string>();
    for (const event of observations) {
      if (event.status === "REDACTED") { report.attribution.redactedEvents++; continue; }
      report.attribution.retainedMatchedEvents++; increment(report.coverage.matchedEvidenceByIngestionMode, event.ingestionMode); increment(report.coverage.matchedEvidenceByProcessingMode, event.processingMode);
      const values: ObservedReferenceValues = {};
      for (const key of keys) if (typeof event[key] === "string" && event[key].trim() && event[key].length <= 1000 && !/[\u0000-\u001f\u007f]/.test(event[key])) values[key] = event[key].trim();
      if (!Object.keys(values).length) continue;
      const id = JSON.stringify([event.sourceId, values]), refs = subjectReferences.get(event.subjectId) ?? new Set<string>(); refs.add(id); subjectReferences.set(event.subjectId, refs);
      if (values.utm_source && values.utm_medium && values.utm_campaign) complete.add(event.subjectId);
      let group = groups.get(id); if (!group) { group = { result: { sourceId: event.sourceId, sourceName: event.sourceName, provider: event.provider, values, subjects: 0, events: 0, authorityCounts: {} }, subjects: new Set() }; groups.set(id, group); }
      group.subjects.add(event.subjectId); group.result.events++; increment(group.result.authorityCounts, event.authority ?? "UNKNOWN");
    }
    report.attribution.references = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => ({ ...g.result, subjects: g.subjects.size }));
    report.attribution.taggedSubjects = subjectReferences.size; report.attribution.unknownSubjects = totalSubjects - subjectReferences.size;
    report.attribution.partialSubjects = subjectReferences.size - complete.size;
    report.attribution.multiReferenceSubjects = [...subjectReferences.values()].filter(refs => refs.size > 1).length;
    report.coverage.unknownCampaignSubjects = report.attribution.unknownSubjects;
  }
  private async campaigns(tx: Tx, report: FunnelReport, journeyIds: string[], asOf: Date, ownerId: string) {
    const owned = { ownerId, environment: report.funnel.environment };
    const links = limited(await tx.stageCampaignLink.findMany({ where: { ...owned, versionId: report.version.id }, take: this.limits.campaignRows + 1,
      select: { key: true, stageKey: true, campaignId: true, campaign: { select: { name: true } } } }), this.limits.campaignRows);
    report.campaigns.configuredLinks = links.map(link => ({ linkId: link.key, stageId: link.stageKey, campaignId: link.campaignId, campaignName: link.campaign.name, purpose: "ATTRIBUTION" }));
    if (!journeyIds.length) return;
    const reasons = limited(await tx.campaignMembershipReason.findMany({ where: { ...owned, journeyId: { in: journeyIds }, createdAt: { lte: asOf } }, take: this.limits.campaignRows + 1,
      select: { id: true, membershipId: true, endedAt: true, membership: { select: { id: true, campaignId: true, revisionId: true, status: true, scopeKind: true,
        campaign: { select: { name: true } }, campaignRevision: { select: { number: true } } } } } }), this.limits.campaignRows);
    const reasonIds = reasons.map(r => r.id), membershipIds = new Set(reasons.map(r => r.membershipId));
    const attributions = reasonIds.length ? limited(await tx.messageSendAttribution.findMany({ where: { ...owned, reasonId: { in: reasonIds }, createdAt: { lte: asOf } }, take: this.limits.campaignRows + 1,
      select: { reasonId: true, sendId: true, membershipId: true, send: { select: { revisionId: true, status: true, deliveryState: true } } } }), this.limits.campaignRows) : [];
    const sendIds = [...new Set(attributions.map(a => a.sendId))];
    const allAttributions = sendIds.length ? limited(await tx.messageSendAttribution.findMany({ where: { ...owned, sendId: { in: sendIds }, createdAt: { lte: asOf } }, take: this.limits.campaignRows + 1,
      select: { sendId: true, reasonId: true, reason: { select: { journeyId: true } } } }), this.limits.campaignRows) : [];
    const cohortReasons = new Set(reasonIds), fanout = new Map<string, { journeys: Set<string>; outside: boolean }>();
    for (const a of allAttributions) { const value = fanout.get(a.sendId) ?? { journeys: new Set<string>(), outside: false }; if (a.reason.journeyId) value.journeys.add(a.reason.journeyId); if (!cohortReasons.has(a.reasonId)) value.outside = true; fanout.set(a.sendId, value); }
    const groups = new Map<string, { result: FunnelCampaignResult; memberships: Set<string>; sends: Set<string> }>(), reasonGroup = new Map<string, string>();
    for (const reason of reasons) {
      const m = reason.membership, key = m.revisionId; reasonGroup.set(reason.id, key);
      let group = groups.get(key); if (!group) { group = { result: { campaignId: m.campaignId, campaignName: m.campaign.name, revisionId: m.revisionId, revisionNumber: m.campaignRevision.number, membershipScope: m.scopeKind as "SUBJECT" | "CONTACT",
        memberships: { unique: 0, statusCounts: {}, reasons: 0, activeReasons: 0, endedReasons: 0 }, sends: { unique: 0, attributionRows: 0, statusCounts: {}, deliveryStateCounts: {}, sharedAcrossJourneys: 0, sharedOutsideCohort: 0 } }, memberships: new Set(), sends: new Set() }; groups.set(key, group); }
      group.result.memberships.reasons++; if (reason.endedAt) group.result.memberships.endedReasons++; else group.result.memberships.activeReasons++;
      if (!group.memberships.has(m.id)) { group.memberships.add(m.id); increment(group.result.memberships.statusCounts, m.status); }
    }
    for (const attribution of attributions) {
      const group = groups.get(reasonGroup.get(attribution.reasonId)!)!; group.result.sends.attributionRows++;
      if (group.sends.has(attribution.sendId)) continue; group.sends.add(attribution.sendId);
      increment(group.result.sends.statusCounts, attribution.send.status); increment(group.result.sends.deliveryStateCounts, attribution.send.deliveryState);
      if ((fanout.get(attribution.sendId)?.journeys.size ?? 0) > 1) group.result.sends.sharedAcrossJourneys++;
      if (fanout.get(attribution.sendId)?.outside) group.result.sends.sharedOutsideCohort++;
    }
    report.campaigns.results = [...groups.values()].map(g => ({ ...g.result, memberships: { ...g.result.memberships, unique: g.memberships.size }, sends: { ...g.result.sends, unique: g.sends.size } }));
    report.campaigns.uniqueMemberships = membershipIds.size; report.campaigns.uniqueAttributedSends = sendIds.length;
  }
}
