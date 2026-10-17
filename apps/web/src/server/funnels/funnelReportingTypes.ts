/** Public aggregate reporting contract; contact summaries use the separate operational API. */
export type FunnelReportEnvironment = "TEST" | "LIVE";
export type FunnelReportSubjectKind = "CONTACT" | "SALES" | "PURCHASE" | "SUBSCRIPTION";
export type FunnelReportJourneyStatus = "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type FunnelReportAuthority = "PROVIDER_VERIFIED" | "SERVER_ASSERTED" | "USER_RECORDED";

export type FunnelReportRequest = {
  /** Must belong to this funnel. Omission selects its current published version. */
  versionId?: string;
  /** Explicit-offset ISO instants; entry cohort is [from,to). */
  from: string;
  to: string;
};

export type ReportRatio = {
  numerator: number;
  denominator: number;
  /** 0..1; null when denominator is zero. Not a percentage string. */
  value: number | null;
};

export type ReportDuration = {
  /** Number of valid observed intervals. No imputed zero for missing history. */
  count: number;
  meanMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
};

export type ReportJourneyStatuses = Record<FunnelReportJourneyStatus, number>;

export type FunnelStageReport = {
  /** Immutable version's stage key, not the current draft's stage label. */
  stageId: string;
  name: string;
  entry: boolean;
  goal: boolean;
  terminal: "NONE" | "SUCCESS" | "FAILURE";
  everReachedJourneys: number;
  /** Denominator is every journey cycle in this selected cohort. */
  reachRate: ReportRatio;
  currentJourneys: number;
  activeJourneys: number;
  currentByStatus: ReportJourneyStatuses;
  /** First recorded stage of the cycle. Later-stage entrants remain in cohort. */
  entryJourneys: number;
  manualEntryJourneys: number;
  /** Genuine entries/reentries; excludes JOURNEY_CANCELLED audit markers. */
  visits: number;
  manualVisits: number;
  /** Unique journeys with a recorded move away; no inferred abandonment. */
  movedOnJourneys: number;
  /** Current failed/cancelled positions, distinct from pending ACTIVE work. */
  knownExitJourneys: number;
  /** Next stage entry or journey.endedAt closes a recorded visit. */
  completedResidence: ReportDuration;
  /** Ages of final ACTIVE visits measured through cohort.asOf, censored. */
  openResidence: ReportDuration;
};

export type FunnelBranchReport = {
  kind: "AUTOMATIC_BRANCH" | "AUTOMATIC_FALLBACK" | "AUTOMATIC_UNKNOWN_BRANCH" | "MANUAL";
  ruleId: string | null;
  branchId: string | null;
  fromStageId: string | null;
  toStageId: string;
  journeys: number;
  transitions: number;
  /** Source-stage ever-reached set, or all cohort journeys for entry routes. */
  progression: ReportRatio;
  denominatorBasis: "SOURCE_STAGE_REACHED" | "ALL_COHORT_JOURNEYS";
};

export type FunnelGoalReport = {
  stageId: string;
  name: string;
  journeys: number;
  conversion: ReportRatio;
  /** Journey.startedAt to first recorded entry into this goal stage. */
  timeToFirstReach: ReportDuration;
};

export type ReportMoneyMeasure = {
  /** Canonical decimal string. Never a binary float or currency conversion. */
  amount: string;
  facts: number;
  valuedFacts: number;
  unvaluedFacts: number;
  /** Fact provenance, not an assertion that user/server evidence is payment proof. */
  authorityCounts: Record<FunnelReportAuthority, number>;
};

export type FunnelCurrencyReport = {
  currency: string;
  grossPaid: ReportMoneyMeasure;
  successfulRefunds: ReportMoneyMeasure;
  /** Gross paid minus successful refunds in this currency; may be negative. */
  netObservedCash: string;
  /** deal.won is recorded sales value, not cash received. */
  recordedWonValue: ReportMoneyMeasure;
};

export type ObservedReferenceValues = {
  campaign?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

export type FunnelObservedReference = {
  sourceId: string;
  /** Current display metadata; stable sourceId is the grouping identity. */
  sourceName: string;
  provider: string;
  values: ObservedReferenceValues;
  subjects: number;
  events: number;
  authorityCounts: Record<string, number>;
};

export type FunnelCampaignResult = {
  campaignId: string;
  /** Current display name, not a claimed historical name. */
  campaignName: string;
  /** Actual membership/send pinned revision, never reason.requestedRevisionId. */
  revisionId: string;
  revisionNumber: number;
  membershipScope: "SUBJECT" | "CONTACT";
  memberships: {
    unique: number;
    statusCounts: Record<string, number>;
    reasons: number;
    activeReasons: number;
    endedReasons: number;
  };
  sends: {
    /** Unique sends with an explicit attribution to a reason in this cohort. */
    unique: number;
    attributionRows: number;
    statusCounts: Record<string, number>;
    deliveryStateCounts: Record<string, number>;
    /** Sends also attributed to another distinct journey, inside or outside cohort. */
    sharedAcrossJourneys: number;
    /** Sends also attributed to a reason outside this cohort, including manual reasons. */
    sharedOutsideCohort: number;
  };
};

export type FunnelReport = {
  schemaVersion: 1;
  funnel: {
    id: string;
    name: string;
    environment: FunnelReportEnvironment;
    subjectKind: FunnelReportSubjectKind;
  };
  version: { id: string; number: number; publishedAt: string };
  cohort: {
    from: string;
    to: string;
    /** One captured current snapshot. Historical asOf is not supported. */
    asOf: string;
    basis: "JOURNEY_STARTED_AT";
    interval: "FROM_INCLUSIVE_TO_EXCLUSIVE";
    unit: "JOURNEY_CYCLE";
    entryPolicy: "ANY_CONFIGURED_ENTRY";
  };
  totals: {
    journeys: number;
    distinctSubjects: number;
    /** Additional cycles in this cohort beyond its distinct subject count. */
    repeatCycles: number;
    active: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    goalJourneys: number;
    goalRate: ReportRatio;
    manualEntryJourneys: number;
    journeysWithManualChanges: number;
    timeToFirstGoal: ReportDuration;
  };
  stages: FunnelStageReport[];
  branches: FunnelBranchReport[];
  goals: FunnelGoalReport[];
  money: {
    basis: "DISTINCT_COHORT_SUBJECT_FACTS";
    factWindow: { from: string; to: string; interval: "BOTH_INCLUSIVE" };
    /** No opportunity value model exists. Never infer pipeline from goal names. */
    pipelineValue: { available: false; reason: "NO_OPPORTUNITY_VALUE_MODEL" };
    currencies: FunnelCurrencyReport[];
    includedFacts: number;
    valuedFacts: number;
    unvaluedFacts: number;
    missingOrInvalidCurrencyFacts: number;
    /** Retained facts before cohort.from, excluded from amounts above. */
    excludedBeforeWindowFacts: number;
    /** Distinct facts in the window, deduplicated across repeat subject cycles. */
    authorityCounts: Record<FunnelReportAuthority, number>;
  };
  attribution: {
    model: "OBSERVED_REFERENCES";
    keys: ["campaign", "utm_source", "utm_medium", "utm_campaign"];
    evidenceBasis: "RETAINED_MATCHED_SUBJECT_HISTORY_THROUGH_AS_OF";
    taggedSubjects: number;
    /** No retained approved tag; does not mean organic/direct acquisition. */
    unknownSubjects: number;
    /** Tagged, but no complete retained source+medium+campaign UTM tuple. */
    partialSubjects: number;
    partialBasis: "NO_COMPLETE_RETAINED_UTM_TUPLE";
    multiReferenceSubjects: number;
    retainedMatchedEvents: number;
    redactedEvents: number;
    references: FunnelObservedReference[];
    nonAdditive: true;
    revenueCredit: "NONE";
  };
  campaigns: {
    /** Published configuration only; not enrollment, consent or attribution proof. */
    configuredLinks: { linkId: string; stageId: string; campaignId: string; campaignName: string; purpose: "ATTRIBUTION" }[];
    results: FunnelCampaignResult[];
    uniqueMemberships: number;
    uniqueAttributedSends: number;
    /** A shared send can appear in another version/cohort report. */
    nonAdditiveAcrossReports: true;
    associationBasis: "EXPLICIT_MEMBERSHIP_REASON_AND_SEND_ATTRIBUTION";
  };
  coverage: {
    transitionRows: number;
    stageEntryTransitions: number;
    manualTransitions: number;
    cancellationCommands: number;
    historyModeTransitions: number;
    redactedTraceTransitions: number;
    journeysWithMissingEntryHistory: number;
    invalidDurationIntervals: number;
    /** Original ingestion modes of retained MATCHED attribution evidence. */
    matchedEvidenceByIngestionMode: Record<string, number>;
    /** Current processing modes may be REPLAY after an audited repair. */
    matchedEvidenceByProcessingMode: Record<string, number>;
    unknownCampaignSubjects: number;
    factProvenance: Record<FunnelReportAuthority, number>;
    dataBasis: "PERSISTED_EVIDENCE_NOT_LIVE_INSTALLATION_VERIFICATION";
    /** Complete bounded snapshot or explicit error; never a truncated report. */
    completeWithinLimits: true;
  };
};

/** Separate operational board DTO; these fields never appear in FunnelReport. */
export type FunnelJourneyBoardQuery = {
  versionId?: string;
  from?: string;
  to?: string;
};

export type FunnelJourneySubjectSummary = {
  id: string;
  kind: FunnelReportSubjectKind;
  contact: { id: string; name: string | null; email: string | null } | null;
};
