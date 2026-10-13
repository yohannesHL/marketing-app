"use client";
import { useEffect, useState } from "react";
import { Alert, Button, Input, Select, Stack, Typography } from "@launchpad/ui";
import { microsToUsd, usdToMicros } from "../connections/connectionUi";
import { socialRequest, SocialUiError } from "./socialUi";

export interface XQuoteInput {
  destinationId: string; body: string; format: "TEXT" | "IMAGE" | "SHORT_VIDEO"; mediaIds: string[];
}
interface XQuote {
  mode: "mock" | "live"; kind: "ESTIMATED_API_ALLOCATION"; weightedLength: number; maxWeightedLength: 280;
  initialEstimateMicros: number; withRenewalEstimateMicros: number; includesUrl: boolean;
  actualBill: null; providerCreditBalance: null;
}
export function XControls({ options, onChange, disabled, quoteInput }: {
  options: Record<string, unknown>; onChange(options: Record<string, unknown>): void; disabled?: boolean; quoteInput?: XQuoteInput;
}) {
  const [limit, setLimit] = useState(typeof options.maxApiCostMicros === "number" ? microsToUsd(options.maxApiCostMicros) : typeof options.maxApiCostMicros === "string" ? microsToUsd(Number(options.maxApiCostMicros)) : "");
  const [retry, setRetry] = useState(0);
  const [estimate, setEstimate] = useState<{ key: string; quote?: XQuote; error?: string }>();
  const key = quoteInput ? JSON.stringify(quoteInput) : "";
  const current = estimate?.key === key ? estimate : undefined;
  useEffect(() => {
    let cancelled = false;
    if (!key) return;
    const timer = setTimeout(() => {
      void socialRequest<XQuote>("/api/social/x/quote", "POST", JSON.parse(key)).then((quote) => {
        if (cancelled) return;
        if (quote.kind !== "ESTIMATED_API_ALLOCATION" || !["mock", "live"].includes(quote.mode) ||
          ![quote.weightedLength, quote.initialEstimateMicros, quote.withRenewalEstimateMicros].every((value) => Number.isSafeInteger(value) && value >= 0) ||
          quote.maxWeightedLength !== 280 || quote.actualBill !== null || quote.providerCreditBalance !== null)
          throw new Error("Invalid estimate");
        setEstimate({ key, quote });
      }).catch((failure) => {
        if (!cancelled) setEstimate({ key, error: failure instanceof SocialUiError ? failure.message : "The X estimate could not load. Review your text and attachments, then edit or retry." });
      });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, retry]);
  const cap = usdToMicros(limit);
  const boolean = (field: string, label: string) => <Select label={label} placeholder="Choose explicitly" disabled={disabled}
    value={options[field] === true ? "yes" : options[field] === false ? "no" : ""}
    options={[{ label: "Yes", value: "yes" }, { label: "No", value: "no" }]}
    onChange={(event) => { const next = { ...options }; if (!event.target.value) delete next[field]; else next[field] = event.target.value === "yes"; onChange(next); }} />;
  return <Stack gap={3}>
    <Alert title="Review X API costs" tone="warning" role="note">Connecting, checking identities and publishing can incur API costs. This draft estimate runs locally without contacting X or allocating spending. It is not an actual bill or available provider credits.</Alert>
    <div role="status" aria-live="polite" data-testid="x-local-estimate">
      {current?.quote ? <Stack gap={2}>
        <Typography>{current.quote.weightedLength} / 280 weighted characters.</Typography>
        <Typography>Initial API allocation estimate: US${microsToUsd(current.quote.initialEstimateMicros)}.</Typography>
        <Typography>Including a possible identity check on renewal: US${microsToUsd(current.quote.withRenewalEstimateMicros)}.</Typography>
        {current.quote.includesUrl ? <Typography variant="caption">This post contains a URL; the configured URL-post rate applies.</Typography> : null}
        <Typography variant="caption">{current.quote.mode === "mock" ? "Synthetic Mockoon fixture rates; no real API charges." : "Based on your operator's configured conservative rates. The owner must verify current rates and credits in X's Developer Console."}</Typography>
        <Typography variant="caption">Actual bill: unavailable. Provider credit balance: unavailable.</Typography>
      </Stack> : current?.error ? <Stack gap={2}><Typography tone="danger">{current.error} Check the owned destination, weighted text limit, attachments and workspace rate configuration.</Typography><Button variant="secondary" disabled={disabled} onClick={() => { setEstimate(undefined); setRetry((value) => value + 1); }}>Try X estimate again</Button></Stack> : <Typography>{key ? "Checking weighted text and estimating the current draft…" : "Choose an owned X destination and content to estimate its allocation."}</Typography>}
    </div>
    <Input label="Maximum X publishing API cost (USD)" inputMode="decimal" placeholder="Enter your limit" value={limit} disabled={disabled}
      description="Approve your maximum in US dollars, with up to six decimal places. No limit is selected automatically. Saving does not publish or spend."
      onChange={(event) => { setLimit(event.target.value); const next = { ...options }, parsed = usdToMicros(event.target.value);
        if (parsed === undefined) delete next.maxApiCostMicros; else next.maxApiCostMicros = parsed; onChange(next); }} />
    {limit && cap === undefined ? <Typography role="status" tone="danger">Enter a nonnegative dollar amount with no more than six decimal places.</Typography> : null}
    {cap !== undefined && current?.quote && cap < current.quote.withRenewalEstimateMicros ? <Typography role="status" tone="warning">Your limit is below the allocation estimate including possible renewal. Review the amount before approving or scheduling.</Typography> : null}
    {boolean("madeWithAi", "This X post was made with AI")}
    {boolean("paidPartnership", "This X post is a paid partnership")}
  </Stack>;
}
