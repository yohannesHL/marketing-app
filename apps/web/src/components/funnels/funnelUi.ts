import type { FunnelDefinition } from "../../server/funnels/funnelDefinition";

export type Environment = "TEST" | "LIVE";
export type UiSource = { id: string; name: string; provider: string; environment: Environment; status: string;
  config: { allowedEvents: string[]; propertyKeys: string[]; allowedOrigins: string[]; correlationField?: string } };
export type UiCampaign = { id: string; name: string; environment: Environment; category: string; status: string;
  publishedRevisionId: string | null; enrolmentEnabled: boolean; dispatchEnabled: boolean };
export type UiVersion = { id: string; number: number; definition: FunnelDefinition; publishedAt: string };
export type UiFunnel = { id: string; name: string; environment: Environment; subjectKind: string; status: string;
  draft: FunnelDefinition; draftRevision: number; publishedVersionId: string | null; versions?: UiVersion[];
  automationEnrolmentEnabled: boolean; automationDispatchEnabled: boolean; createdAt: string };
export type UiJourney = { id: string; subjectId: string; versionId: string; cycle: number; currentStageKey: string;
  status: string; startedAt: string; endedAt: string | null; revision: number; subject?: import("../../server/funnels/funnelReportingTypes").FunnelJourneySubjectSummary };
export const inputClass = "input input-bordered w-full min-w-0 min-h-11";
export const buttonClass = "btn btn-secondary min-h-11 normal-case whitespace-normal h-auto py-2";
export const panelClass = "rounded-box border border-base-300 bg-base-100 p-4 sm:p-5 min-w-0";
export class FunnelUiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export async function funnelRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new FunnelUiError("NETWORK_ERROR", 503, "Could not reach the workspace. Your edits are still here. Try again."); }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new FunnelUiError(value?.code ?? "REQUEST_FAILED", response.status,
    response.status === 401 ? "Your session ended. Sign in again; keep this tab open to preserve your edits." : value?.message ?? "This request could not be completed.");
  return value as T;
}
export function message(error: unknown) { return error instanceof Error ? error.message : "This request could not be completed."; }
export function dateLabel(value?: string | null) { return value ? new Date(value).toLocaleString() : "Not observed"; }
export function key(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
