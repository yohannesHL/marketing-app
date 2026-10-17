import type { Prisma, PrismaClient, Funnel, FunnelJourney, FunnelVersion, TrackingEvent } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { fields, object, properties as scalarProperties, sha256, text, timestamp } from "./trackingValidation";
import { evaluateFunnel, fieldKey, validateDefinition, type FunnelDefinition, type PropertyValues, type Scalar } from "./funnelDefinition";
import type { NormalizedTrackingEvent } from "./trackingTypes";

type Tx = Prisma.TransactionClient;
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Observation = { state: "VALUE" | "UNKNOWN"; value?: Scalar; reason?: "CONFLICT"; observedAt: string; versionAt: string; eventId: string; sourceGeneration?: number };
const builtInProperties = ["amount", "currency", "presentmentAmount", "presentmentCurrency", "financialStatus", "cancelled", "rescheduled", "test", "orderId", "transactionId", "status"];
const definitionOf = (version: FunnelVersion) => version.definition as unknown as FunnelDefinition;
const statusFor = (stage: FunnelDefinition["stages"][number]) => stage.terminal === "SUCCESS" ? "SUCCEEDED" : stage.terminal === "FAILURE" ? "FAILED" : "ACTIVE";

/** Definitions, evaluation, history and the internal outbox share one database transaction boundary. */
export class FunnelService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date()) {}
  private async session(tx: Tx, principal: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx | PrismaClient, principal: CustomerPrincipal, id: string) {
    const funnel = await tx.funnel.findFirst({ where: { id, ownerId: principal.userId } });
    if (!funnel) fail("NOT_FOUND", 404, "Funnel not found."); return funnel;
  }
  private environment(value: unknown) {
    if (value !== "TEST" && value !== "LIVE") fail("INVALID_FUNNEL_INPUT", 400, "Choose TEST or LIVE."); return value;
  }
  private revision(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) fail("INVALID_FUNNEL_INPUT", 400, "Supply the draft revision you edited."); return Number(value);
  }
  async list(principal: CustomerPrincipal, environment: string) {
    await this.auth.assertSession(principal); this.environment(environment);
    return this.db.funnel.findMany({ where: { ownerId: principal.userId, environment }, orderBy: { createdAt: "desc" }, take: 100 });
  }
  async create(principal: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["name", "environment", "subjectKind", "definition"]);
    const name = text(input.name, 120), environment = this.environment(input.environment), subjectKind = text(input.subjectKind);
    if (!["CONTACT", "SALES", "PURCHASE"].includes(subjectKind)) fail("INVALID_FUNNEL_INPUT", 400, "Choose people, sales enquiries or purchases.");
    const definition = validateDefinition(input.definition);
    return this.db.$transaction(async tx => {
      await this.session(tx, principal);
      if (await tx.funnel.count({ where: { ownerId: principal.userId, environment } }) >= 100) fail("FUNNEL_LIMIT", 409, "This environment supports up to 100 funnels.");
      return tx.funnel.create({ data: { ownerId: principal.userId, environment, subjectKind, name, draft: jsonValue(definition), createdAt: this.now() } });
    });
  }
  async get(principal: CustomerPrincipal, id: string) {
    await this.auth.assertSession(principal); const funnel = await this.owned(this.db, principal, id);
    const versions = await this.db.funnelVersion.findMany({ where: { funnelId: id }, orderBy: { number: "desc" }, take: 30 });
    return { ...funnel, versions, publicationPolicy: "FUTURE_EVENTS_ONLY", existingRuns: "PINNED_VERSION", externalActions: false };
  }
  async updateDraft(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["draftRevision", "name", "definition"]);
    const draftRevision = this.revision(input.draftRevision), definition = validateDefinition(input.definition);
    const name = input.name === undefined ? undefined : text(input.name, 120);
    return this.db.$transaction(async tx => {
      await this.session(tx, principal); await this.owned(tx, principal, id);
      const changed = await tx.funnel.updateMany({ where: { id, draftRevision }, data: { draft: jsonValue(definition), name, draftRevision: { increment: 1 } } });
      if (!changed.count) fail("DRAFT_CHANGED", 409, "This draft changed. Reload before saving.");
      return tx.funnel.findUniqueOrThrow({ where: { id } });
    });
  }
  private requirements(definition: FunnelDefinition) {
    const requirements: { sourceId: string; type: string; key?: string }[] = [];
    const visit = (condition: unknown, trigger: { sourceId: string; type: string }) => {
      if (!condition) return;
      const node = condition as { all?: unknown[]; any?: unknown[]; field?: { scope: string; sourceId?: string; type?: string; key: string } };
      if (node.all || node.any) for (const child of node.all ?? node.any ?? []) visit(child, trigger);
      if (node.field) requirements.push(node.field.scope === "EVENT" ? { ...trigger, key: node.field.key } : { sourceId: node.field.sourceId!, type: node.field.type!, key: node.field.key });
    };
    for (const route of definition.routes) {
      requirements.push(route.trigger);
      for (const branch of route.branches) visit(branch.when, route.trigger);
    }
    return requirements;
  }
  private async validateSources(tx: Tx, funnel: Funnel, definition: FunnelDefinition) {
    const requirements = this.requirements(definition);
    const sources = await tx.trackingSource.findMany({ where: { id: { in: [...new Set(requirements.map(r => r.sourceId))] }, ownerId: funnel.ownerId, environment: funnel.environment } });
    for (const requirement of requirements) {
      const source = sources.find(s => s.id === requirement.sourceId);
      if (!source || source.status !== "ACTIVE") fail("FUNNEL_SOURCE_UNAVAILABLE", 409, "Every rule needs an active source owned by this customer in the same environment.");
      const config = source.config as unknown as { allowedEvents: string[]; propertyKeys: string[] };
      if (!config.allowedEvents.includes(requirement.type)) fail("FUNNEL_EVENT_UNAVAILABLE", 409, `The source does not accept ${requirement.type}.`);
      if (requirement.key && !config.propertyKeys.includes(requirement.key) && !(source.provider !== "NATIVE" && builtInProperties.includes(requirement.key)))
        fail("FUNNEL_PROPERTY_UNAVAILABLE", 409, `Configure property ${requirement.key} on its source before publishing.`);
    }
  }
  async publish(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["draftRevision"]); const revision = this.revision(input.draftRevision);
    return this.db.$transaction(async tx => {
      await this.session(tx, principal); const funnel = await this.owned(tx, principal, id);
      if (funnel.draftRevision !== revision) fail("DRAFT_CHANGED", 409, "Review the current draft before publishing.");
      const definition = validateDefinition(funnel.draft);
      if (!definition.stages.length || !definition.entryStages.length) fail("INVALID_FUNNEL_DEFINITION", 400, "Add a stage and at least one allowed entry stage.");
      await this.validateSources(tx, funnel, definition);
      const prior = await tx.funnelVersion.findFirst({ where: { funnelId: id }, orderBy: { number: "desc" } });
      const digest = sha256(JSON.stringify(definition));
      if (prior?.digest === digest) return { version: prior, existing: true, publicationPolicy: "FUTURE_EVENTS_ONLY" };
      const version = await tx.funnelVersion.create({ data: { ownerId: funnel.ownerId, environment: funnel.environment, funnelId: id,
        number: (prior?.number ?? 0) + 1, definition: jsonValue(definition), digest, publishedAt: this.now() } });
      for (const stage of definition.stages) await tx.funnelStage.create({ data: { ownerId: funnel.ownerId, environment: funnel.environment,
        versionId: version.id, key: stage.id, name: stage.name, goal: stage.goal, terminal: stage.terminal } });
      await tx.funnel.update({ where: { id }, data: { publishedVersionId: version.id } });
      return { version, existing: false, publicationPolicy: "FUTURE_EVENTS_ONLY", existingRuns: "PINNED_VERSION", externalActions: false };
    });
  }
  async setStatus(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["status"]);
    const status = text(input.status); if (!["ACTIVE", "PAUSED", "ARCHIVED"].includes(status)) fail("INVALID_FUNNEL_INPUT", 400, "Choose an available funnel status.");
    return this.db.$transaction(async tx => { await this.session(tx, principal); await this.owned(tx, principal, id);
      return tx.funnel.update({ where: { id }, data: { status } }); });
  }
  async journeys(principal: CustomerPrincipal, id: string, cursor?: string) {
    await this.auth.assertSession(principal); await this.owned(this.db, principal, id);
    const journeys = await this.db.funnelJourney.findMany({ where: { funnelId: id, ownerId: principal.userId, ...(cursor ? { id: { gt: text(cursor) } } : {}) }, orderBy: { id: "asc" }, take: 50 });
    return { journeys, nextCursor: journeys.length === 50 ? journeys.at(-1)!.id : null };
  }
  async history(principal: CustomerPrincipal, id: string, journeyId: string) {
    await this.auth.assertSession(principal); await this.owned(this.db, principal, id);
    const journey = await this.db.funnelJourney.findFirst({ where: { id: journeyId, funnelId: id, ownerId: principal.userId } });
    if (!journey) fail("NOT_FOUND", 404, "Journey not found.");
    const transitions = await this.db.funnelStageTransition.findMany({ where: { journeyId }, orderBy: { sequence: "asc" }, take: 1000 });
    const effects = await this.db.funnelEvidenceEffect.findMany({ where: { funnelId: id, subjectId: journey.subjectId, cycle: journey.cycle }, orderBy: { createdAt: "desc" }, take: 100 });
    return { journey, transitions, effects, externalActions: false };
  }

  private async transition(tx: Tx, funnel: Funnel, version: FunnelVersion, subjectId: string, existing: FunnelJourney | null, input: {
    stageId: string; occurredAt: Date; mode: string; reasonCode: string; trace: unknown; triggerKind: string;
    eventId?: string; receiptId?: string; ruleId?: string; actorId?: string; note?: string; commandKey?: string; commandDigest?: string; cycle?: number;
  }) {
    const stage = definitionOf(version).stages.find(s => s.id === input.stageId)!;
    const status = statusFor(stage), recordedAt = this.now();
    const journey = existing ? await tx.funnelJourney.update({ where: { id: existing.id }, data: { currentStageKey: stage.id,
      status, endedAt: status === "ACTIVE" ? null : recordedAt, revision: { increment: 1 }, lastTransitionOccurredAt: input.occurredAt } }) :
      await tx.funnelJourney.create({ data: { ownerId: funnel.ownerId, environment: funnel.environment, funnelId: funnel.id,
        versionId: version.id, subjectId, cycle: input.cycle ?? 1, currentStageKey: stage.id, status, startedAt: recordedAt,
        endedAt: status === "ACTIVE" ? null : recordedAt, lastTransitionOccurredAt: input.occurredAt } });
    const transition = await tx.funnelStageTransition.create({ data: { ownerId: funnel.ownerId, environment: funnel.environment,
      journeyId: journey.id, versionId: version.id, sequence: journey.revision, fromStageKey: existing?.currentStageKey ?? null, toStageKey: stage.id,
      ruleId: input.ruleId, eventId: input.eventId, receiptId: input.receiptId, actorId: input.actorId, triggerKind: input.triggerKind,
      mode: input.mode, reasonCode: input.reasonCode, note: input.note, evaluationTrace: jsonValue(input.trace), occurredAt: input.occurredAt, recordedAt,
      commandKey: input.commandKey, commandDigest: input.commandDigest } });
    // Captured empty plan is intentional: installing email execution later cannot activate historical entries.
    await tx.funnelActionOutbox.create({ data: { ownerId: funnel.ownerId, environment: funnel.environment, journeyId: journey.id,
      transitionId: transition.id, kind: "STAGE_ENTERED", actionKey: "stage-entry", payload: jsonValue({ schemaVersion: 1, stageId: stage.id, versionId: version.id, actions: [] }),
      mode: input.mode, effectEligibility: "TRACKING_ONLY", status: "RECORDED", createdAt: recordedAt, completedAt: recordedAt } });
    return { journey, transition };
  }
  async move(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["subjectId", "stageId", "reason", "commandKey", "newCycle"]);
    const subjectId = text(input.subjectId), stageId = text(input.stageId), reason = text(input.reason, 500), commandKey = text(input.commandKey, 128);
    if (input.newCycle !== undefined && typeof input.newCycle !== "boolean") fail("INVALID_FUNNEL_INPUT", 400, "Choose whether to start a new cycle.");
    const commandDigest = sha256(JSON.stringify([id, subjectId, stageId, reason, input.newCycle ?? false]));
    return this.db.$transaction(async tx => {
      await this.session(tx, principal); const funnel = await this.owned(tx, principal, id);
      const previous = await tx.funnelStageTransition.findUnique({ where: { ownerId_commandKey: { ownerId: principal.userId, commandKey } } });
      if (previous) {
        if (previous.commandDigest !== commandDigest) fail("IDEMPOTENCY_CONFLICT", 409, "This command key was used for a different move.");
        return { journey: await tx.funnelJourney.findUniqueOrThrow({ where: { id: previous.journeyId } }), transition: previous, duplicate: true };
      }
      const subject = await tx.funnelSubject.findFirst({ where: { id: subjectId, ownerId: principal.userId, environment: funnel.environment, kind: funnel.subjectKind } });
      if (!subject || subject.contactId && (await tx.funnelContact.findUnique({ where: { id: subject.contactId } }))?.deletedAt) fail("NOT_FOUND", 404, "Compatible subject not found.");
      const prior = await tx.funnelJourney.findFirst({ where: { funnelId: id, subjectId }, orderBy: { cycle: "desc" } });
      if (prior?.status === "ACTIVE" && input.newCycle) fail("ACTIVE_JOURNEY", 409, "Finish the active journey before starting another cycle.");
      if (prior && prior.status !== "ACTIVE" && !input.newCycle) fail("NEW_CYCLE_REQUIRED", 409, "Explicitly request a new cycle for a finished journey.");
      const active = prior?.status === "ACTIVE" ? prior : null;
      const versionId = active?.versionId ?? funnel.publishedVersionId;
      if (!versionId) fail("FUNNEL_UNPUBLISHED", 409, "Publish the funnel before moving a subject.");
      const version = await tx.funnelVersion.findUniqueOrThrow({ where: { id: versionId } }), definition = definitionOf(version);
      if (!definition.stages.some(s => s.id === stageId) || !active && !definition.entryStages.includes(stageId)) fail("INVALID_STAGE", 400, "Choose a stage in the pinned version and an allowed entry for a new journey.");
      return this.transition(tx, funnel, version, subjectId, active, { stageId, occurredAt: this.now(), mode: "REPLAY", reasonCode: "MANUAL_TRACKING_ONLY",
        trace: { manual: true, externalActions: false }, triggerKind: "MANUAL", actorId: principal.userId, note: reason, commandKey, commandDigest, cycle: (prior?.cycle ?? 0) + 1 });
    });
  }

  private project(fields: Record<string, Observation>, event: { id: string; occurredAt: Date; sourceId: string; type: string; sourceGeneration?: number; envelope: NormalizedTrackingEvent }) {
    const changed: string[] = [], versionAt = event.envelope.resourceUpdatedAt ?? event.occurredAt.toISOString();
    for (const [key, value] of Object.entries(event.envelope.properties)) {
      const previous = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (previous && new Date(previous.versionAt) > new Date(versionAt)) continue;
      if (previous && previous.versionAt === versionAt) {
        if (previous.state === "UNKNOWN") continue;
        if (previous.value === value) {
          // A fresh credential generation may corroborate an unchanged resource without changing its value.
          if (event.sourceGeneration !== undefined && (previous.sourceGeneration ?? 0) < event.sourceGeneration)
            fields[key] = { ...previous, sourceGeneration: event.sourceGeneration, eventId: event.id };
          continue;
        }
        fields[key] = { state: "UNKNOWN", reason: "CONFLICT", versionAt, observedAt: event.occurredAt.toISOString(), eventId: event.id, sourceGeneration: event.sourceGeneration };
      } else fields[key] = { state: "VALUE", value, versionAt, observedAt: event.occurredAt.toISOString(), eventId: event.id, sourceGeneration: event.sourceGeneration };
      if (!previous || previous.state !== fields[key].state || previous.value !== fields[key].value)
        changed.push(fieldKey({ sourceId: event.sourceId, type: event.type, key }));
    }
    return changed;
  }
  private async snapshot(tx: Tx, event: TrackingEvent, subjectId: string) {
    const previous = await tx.funnelPropertySnapshot.findUnique({ where: { subjectId_sourceId_eventType: { subjectId, sourceId: event.sourceId, eventType: event.type } } });
    const observations = (previous?.fields ?? {}) as unknown as Record<string, Observation>;
    const changedFields = this.project(observations, { ...event, envelope: event.envelope as unknown as NormalizedTrackingEvent });
    await tx.funnelPropertySnapshot.upsert({ where: { subjectId_sourceId_eventType: { subjectId, sourceId: event.sourceId, eventType: event.type } },
      create: { ownerId: event.ownerId, environment: event.environment, subjectId, sourceId: event.sourceId, eventType: event.type, fields: jsonValue(observations) },
      update: { fields: jsonValue(observations), revision: { increment: 1 } } });
    const snapshots = await tx.funnelPropertySnapshot.findMany({ where: { subjectId } });
    const properties: PropertyValues = {};
    const sources = await tx.trackingSource.findMany({ where: { id: { in: snapshots.map(s => s.sourceId) } } });
    for (const snapshot of snapshots) for (const [key, observation] of Object.entries(snapshot.fields as unknown as Record<string, Observation>)) {
      const source = sources.find(s => s.id === snapshot.sourceId);
      const unavailable = !source || source.status !== "ACTIVE" || observation.sourceGeneration !== source.generation;
      properties[fieldKey({ sourceId: snapshot.sourceId, type: snapshot.eventType, key })] = unavailable ? { state: "UNKNOWN", reason: "UNAVAILABLE" } :
        observation.state === "UNKNOWN" ? { state: "UNKNOWN", reason: "CONFLICT" } : { state: "VALUE", value: observation.value! };
    }
    return { properties, changedFields };
  }
  async processOnce() {
    return this.db.$transaction(async tx => {
      const receipt = await tx.funnelEvaluationReceipt.findFirst({ where: { status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (!receipt) return null;
      const cancel = (reason: string) => tx.funnelEvaluationReceipt.update({ where: { id: receipt.id }, data: { status: "CANCELLED", reason, completedAt: this.now() } });
      const event = await tx.trackingEvent.findUniqueOrThrow({ where: { id: receipt.eventId } });
      const subject = await tx.funnelSubject.findUniqueOrThrow({ where: { id: receipt.subjectId } });
      if (event.status !== "MATCHED" || event.subjectId !== subject.id || event.matchRevision !== receipt.matchRevision) return cancel("EVIDENCE_CHANGED");
      if (subject.contactId && (await tx.funnelContact.findUnique({ where: { id: subject.contactId } }))?.deletedAt) return cancel("CONTACT_DELETED");
      const source = await tx.trackingSource.findUniqueOrThrow({ where: { id: event.sourceId } });
      if (source.status !== "ACTIVE" || receipt.mode === "LIVE" && source.generation !== event.sourceGeneration) return cancel("SOURCE_CHANGED");
      const projection = await this.snapshot(tx, event, subject.id), envelope = event.envelope as unknown as NormalizedTrackingEvent;
      const funnels = await tx.funnel.findMany({ where: { ownerId: receipt.ownerId, environment: receipt.environment, subjectKind: subject.kind, publishedVersionId: { not: null } }, orderBy: { id: "asc" }, take: 100 });
      for (const funnel of funnels) {
        const prior = await tx.funnelJourney.findFirst({ where: { funnelId: funnel.id, subjectId: subject.id }, orderBy: { cycle: "desc" } });
        const active = prior?.status === "ACTIVE" ? prior : null, cycle = prior?.cycle ?? 1;
        const version = await tx.funnelVersion.findUniqueOrThrow({ where: { id: prior?.versionId ?? funnel.publishedVersionId! } });
        let evidenceKey = event.factId ? `fact:${event.factId}` : `event:${event.id}`;
        const eventConsumed = !!await tx.funnelEvidenceEffect.findUnique({ where: { funnelId_subjectId_cycle_evidenceKey: { funnelId: funnel.id, subjectId: subject.id, cycle, evidenceKey } } });
        if (eventConsumed) {
          if (!projection.changedFields.length) continue;
          evidenceKey = `property:${event.id}`;
          if (await tx.funnelEvidenceEffect.findUnique({ where: { funnelId_subjectId_cycle_evidenceKey: { funnelId: funnel.id, subjectId: subject.id, cycle, evidenceKey } } })) continue;
        }
        let outcome: string | undefined = prior && !active ? "FINISHED_JOURNEY" : !active && funnel.status !== "ACTIVE" ? "ENTRY_PAUSED" :
          !active && receipt.mode !== "LIVE" ? "HISTORY_ONLY_NO_ENTRY" : event.occurredAt < version.publishedAt ? "BEFORE_PUBLICATION" :
          active?.lastTransitionOccurredAt && event.occurredAt < active.lastTransitionOccurredAt ? "LATE" : undefined;
        let ruleId: string | undefined, journeyId = prior?.id;
        if (!outcome) {
          const definition = definitionOf(version), properties = { ...projection.properties };
          const requirements = this.requirements(definition);
          const requiredSources = await tx.trackingSource.findMany({ where: { id: { in: [...new Set(requirements.map(r => r.sourceId))] }, ownerId: funnel.ownerId, environment: funnel.environment } });
          for (const requirement of requirements) if (requirement.key) {
            const source = requiredSources.find(s => s.id === requirement.sourceId);
            if (!source || source.status !== "ACTIVE" || !(source.config as { allowedEvents: string[] }).allowedEvents.includes(requirement.type))
              properties[fieldKey({ ...requirement, key: requirement.key })] = { state: "UNKNOWN", reason: "UNAVAILABLE" };
          }
          const decision = evaluateFunnel(definition, { currentStage: active?.currentStageKey ?? null, eventEligible: !eventConsumed,
            event: { sourceId: event.sourceId, type: event.type, properties: envelope.properties, occurredAt: event.occurredAt.toISOString() },
            properties, changedFields: projection.changedFields });
          outcome = decision.reason; ruleId = decision.ruleId;
          if (decision.outcome === "MOVE") {
            const result = await this.transition(tx, funnel, version, subject.id, active, { stageId: decision.to!, occurredAt: event.occurredAt,
              mode: receipt.mode, reasonCode: decision.reason, trace: decision.trace, triggerKind: "AUTOMATIC", eventId: event.id, receiptId: receipt.id, ruleId, cycle });
            journeyId = result.journey.id;
          }
        }
        await tx.funnelEvidenceEffect.create({ data: { ownerId: receipt.ownerId, environment: receipt.environment, funnelId: funnel.id,
          versionId: version.id, subjectId: subject.id, cycle, journeyId, evidenceKey, outcome, ruleId, createdAt: this.now() } });
      }
      return tx.funnelEvaluationReceipt.update({ where: { id: receipt.id }, data: { status: "CONSUMED", completedAt: this.now() } });
    });
  }
  async simulate(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal); const funnel = await this.owned(this.db, principal, id);
    const input = object(value); fields(input, ["definition", "currentStage", "events"]);
    const definition = validateDefinition(input.definition ?? funnel.draft);
    let currentStage = input.currentStage === undefined || input.currentStage === null ? null : text(input.currentStage);
    if (currentStage && !definition.stages.some(s => s.id === currentStage)) fail("INVALID_STAGE", 400, "Choose a stage in this simulation definition.");
    if (!Array.isArray(input.events) || input.events.length > 100) fail("INVALID_SIMULATION", 400, "Supply at most 100 sample events.");
    const snapshots = new Map<string, Record<string, Observation>>(), properties: PropertyValues = {}, history: unknown[] = [];
    let watermark: string | undefined;
    const consumedEvidence = new Set<string>();
    for (let index = 0; index < input.events.length; index++) {
      const event = object(input.events[index]); fields(event, ["sourceId", "type", "properties", "occurredAt", "resourceUpdatedAt", "evidenceKey"]);
      const sourceId = text(event.sourceId), type = text(event.type), occurredAt = timestamp(event.occurredAt);
      const values = scalarProperties(event.properties, Object.keys(object(event.properties)));
      const resourceUpdatedAt = event.resourceUpdatedAt === undefined ? undefined : timestamp(event.resourceUpdatedAt);
      const evidenceKey = event.evidenceKey === undefined ? `sample:${index}` : `canonical:${text(event.evidenceKey, 512)}`;
      const eventConsumed = consumedEvidence.has(evidenceKey);
      const snapshotKey = JSON.stringify([sourceId, type]), observations = snapshots.get(snapshotKey) ?? {};
      const changedFields = this.project(observations, { id: `sample-${index}`, sourceId, type, occurredAt: new Date(occurredAt), envelope: { properties: values, resourceUpdatedAt } as unknown as NormalizedTrackingEvent });
      snapshots.set(snapshotKey, observations);
      for (const [key, observation] of Object.entries(observations)) properties[fieldKey({ sourceId, type, key })] = observation.state === "UNKNOWN" ? { state: "UNKNOWN", reason: "CONFLICT" } : { state: "VALUE", value: observation.value! };
      const decision = eventConsumed && !changedFields.length ? { outcome: "WAIT", reason: "DUPLICATE_EVIDENCE", trace: { reason: "DUPLICATE_EVIDENCE" }, to: undefined } :
        watermark && new Date(occurredAt) < new Date(watermark) ? { outcome: "WAIT", reason: "LATE", trace: { reason: "LATE" }, to: undefined } :
        evaluateFunnel(definition, { currentStage, eventEligible: !eventConsumed, event: { sourceId, type, properties: values as Record<string, Scalar>, occurredAt }, properties, changedFields });
      consumedEvidence.add(evidenceKey);
      history.push({ sample: index + 1, from: currentStage, ...decision, actions: [], externalEffects: false });
      if (decision.outcome === "MOVE") { currentStage = decision.to!; watermark = occurredAt; }
    }
    return { simulated: true, externalEffects: false, currentStage, history, note: "Sample values only. Reuse evidenceKey for copies of one canonical occurrence; without it every sample is a distinct event. resourceUpdatedAt defaults to occurredAt. Source, publication, identity and consent readiness require separate checks." };
  }
}
