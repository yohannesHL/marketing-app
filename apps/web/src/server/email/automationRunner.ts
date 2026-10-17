import type { PrismaClient } from "../../generated/prisma/client";
import type { FunnelService } from "../funnels/funnelService";
import type { TrackingService } from "../funnels/trackingService";
import { StageActionService } from "../funnels/stageActionService";
import { CampaignStepService } from "./campaignStepService";
import type { EmailConnectionService } from "./emailConnectionService";
import type { EmailDeliveryService } from "./emailDeliveryService";
import { SecurityError } from "../security/errors";

/** Bounded orchestration; the persisted campaign step and send are the only cadence/HTTP authority. */
export class AutomationRunner {
  private readonly actions: StageActionService;
  private readonly steps: CampaignStepService;
  constructor(private readonly db: PrismaClient, private readonly services: {
    delivery: EmailDeliveryService; connections: EmailConnectionService; funnels: FunnelService; tracking?: TrackingService;
  }, private readonly options: { now?: () => Date; liveEnabled?: boolean } = {}) {
    this.actions = new StageActionService(db, options);
    this.steps = new CampaignStepService(db, options);
  }
  private now() { return this.options.now?.() ?? new Date(); }
  async processOnce() {
    const events: { phase: string; status: string }[] = [];
    const record = (phase: string, result: unknown) => { if (result) events.push({ phase, status:
      typeof result === "object" && "status" in result ? String(result.status) : "PROCESSED" }); };
    const leased = async <T>(phase: string, operation: () => Promise<T>) => {
      try { record(phase, await operation()); }
      catch (error) {
        if (!(error instanceof SecurityError) || error.code !== "EMAIL_LEASE_LOST") throw error;
        record(phase, { status: "LEASE_EXPIRED_OR_REPLACED" });
      }
    };
    // Opt-outs/negative delivery evidence and tracking transitions precede each send.
    // The send fence also checks backlog, so independent workers retain this protection.
    record("receipt", await this.services.delivery.processOnce());
    if (this.services.tracking) record("matching", await this.services.tracking.processOnce());
    record("tracking", await this.services.funnels.processOnce());
    record("stage", await this.actions.processOnce());
    record("recovery", await this.services.delivery.recoverOnce());
    record("sender-recovery", await this.services.connections.recoverSenderRefreshOnce());
    record("step", await this.steps.processOnce());
    const now = this.now();
    const ready = await this.db.campaignStepExecution.findMany({ where: { status: "READY", redactedAt: null,
      dueAt: { lte: now }, expiresAt: { gt: now }, OR: [{ nextWakeAt: null }, { nextWakeAt: { lte: now } }],
      membership: { status: "ACTIVE", endedAt: null } }, orderBy: [{ nextWakeAt: "asc" }, { id: "asc" }], take: 10 });
    for (const execution of ready) {
      const refresh = await this.services.connections.claimSenderRefresh(execution.membershipId);
      if (refresh) await leased("sender-refresh", () => this.services.connections.refreshClaimedSender(refresh));
      const intent = await this.services.delivery.createStepIntent(execution.id);
      if ("sendId" in intent) record("intent", { status: intent.kind });
      else await this.db.campaignStepExecution.updateMany({ where: { id: execution.id, status: "READY" }, data: {
        reason: intent.code, nextWakeAt: new Date(Math.min(execution.expiresAt!.getTime(),
          Math.max(this.now().getTime() + 1000, intent.nextWakeAt ? Date.parse(intent.nextWakeAt) : this.now().getTime() + 60_000))), revision: { increment: 1 } } });
    }
    // An already frozen intent may outlive the readiness cache or its original send window.
    const refreshPending = await this.db.messageSend.findFirst({ where: { status: { in: ["PENDING", "FAILED"] },
      stepExecution: { status: "SEND_PENDING" }, expiresAt: { gt: this.now() },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: this.now() } }] }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], select: { membershipId: true } });
    if (refreshPending) {
      const refresh = await this.services.connections.claimSenderRefresh(refreshPending.membershipId);
      if (refresh) await leased("sender-refresh", () => this.services.connections.refreshClaimedSender(refresh));
    }
    const sendLease = await this.services.delivery.claimSend();
    if (sendLease) await leased("delivery", () => this.services.delivery.dispatchClaimed(sendLease));
    const readbackLease = await this.services.delivery.claimReconciliation();
    if (readbackLease) await leased("readback", () => this.services.delivery.reconcileClaimed(readbackLease));
    return events.length ? { status: "PROCESSED", events } : null;
  }
}
