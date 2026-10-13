"use client";
import { useEffect, useRef } from "react";
import { Alert, Button, Checkbox, Select, Stack, Typography } from "@launchpad/ui";
import type { TrustedTikTokCreator } from "../connections/connectionUi";
import { checkedAt } from "../connections/connectionUi";
import { MediaPreview } from "./MediaPreview";
import type { SocialMedia } from "./socialUi";
const labels: Record<string, string> = { PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };
/** The only automatic interaction choices are constraints returned by TikTok. */
export function tikTokCreatorOptions(options: Record<string, unknown>, creator: TrustedTikTokCreator): Record<string, unknown> {
  return { ...options, creatorInfoVersion: creator.version,
    ...(creator.commentDisabled ? { disableComment: true } : {}), ...(creator.duetDisabled ? { disableDuet: true } : {}),
    ...(creator.stitchDisabled ? { disableStitch: true } : {}) };
}
export function tikTokConsentOnlyChange(before: Record<string, unknown>, after: Record<string, unknown>) {
  const other = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).filter(([key]) => key !== "explicitPostingConsent").sort(([a], [b]) => a.localeCompare(b)));
  return typeof after.explicitPostingConsent === "boolean" && before.explicitPostingConsent !== after.explicitPostingConsent && other(before) === other(after);
}
export function TikTokControls({ creator, audited = false, options, onChange, onRefresh, video, disabled = false }: {
  creator?: TrustedTikTokCreator; audited?: boolean; options: Record<string, unknown>; onChange(options: Record<string, unknown>): void;
  onRefresh?: () => void; video?: SocialMedia; disabled?: boolean;
}) {
  const proof = creator ? JSON.stringify([creator.authorizationId, creator.authorizationGeneration, creator.version, creator.checkedAt]) : "unavailable";
  const previousProof = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousProof.current === proof) return;
    // A saved choice can be shown, but initial load and any new server evidence
    // require a new explicit acknowledgment of the exact draft.
    const matchingSavedChoices = previousProof.current === undefined && creator && options.creatorInfoVersion === creator.version;
    previousProof.current = proof;
    const next = creator ? tikTokCreatorOptions(matchingSavedChoices ? options : {}, creator) : {};
    if (creator || Object.keys(options).length) onChange({ ...next, explicitPostingConsent: false });
  }, [proof, creator, onChange, options]);
  const current = creator ? tikTokCreatorOptions(options, creator) : options;
  const privacyLevels = creator?.privacyLevels.filter((level) => audited || level === "SELF_ONLY") ?? [];
  const privacy = privacyLevels.includes(String(current.privacyLevel)) ? String(current.privacyLevel) : "";
  const commercial = current.commercialContentDisclosure === true;
  const privateCreatorRequired = !audited && creator?.privacyLevels.includes("PUBLIC_TO_EVERYONE") === true;
  const videoReady = video?.type === "VIDEO" && (video.status === undefined || video.status === "AVAILABLE") &&
    typeof video.durationMs === "number" && video.durationMs > 0 && creator && video.durationMs <= Math.min(600, creator.maxDurationSeconds) * 1000 &&
    (!video.expiresAt || Date.parse(video.expiresAt) > Date.now());
  const ready = creator && options.creatorInfoVersion === creator.version && !privateCreatorRequired && privacy && videoReady &&
    ["disableComment", "disableDuet", "disableStitch", "commercialContentDisclosure", "brandContentToggle", "brandOrganicToggle", "isAigc"].every((key) => typeof current[key] === "boolean") &&
    current.musicUsageConsent === true && (commercial ? current.brandContentToggle === true || current.brandOrganicToggle === true :
      current.brandContentToggle === false && current.brandOrganicToggle === false) &&
    !(current.brandContentToggle === true && privacy === "SELF_ONLY");
  const set = (patch: Record<string, unknown>) => onChange({ ...current, ...patch, explicitPostingConsent: false });
  const bool = (key: string, label: string, inverted = false, forced = false) => (
    <Select label={label} disabled={disabled || !creator || forced} placeholder="Choose explicitly"
      value={current[key] === true ? (inverted ? "no" : "yes") : current[key] === false ? (inverted ? "yes" : "no") : ""}
      description={forced ? "Disabled by the creator's current TikTok settings." : undefined}
      options={[{ label: "Yes", value: "yes" }, { label: "No", value: "no" }]}
      onChange={(event) => { const next = { ...current }; if (!event.target.value) delete next[key]; else next[key] = inverted ? event.target.value === "no" : event.target.value === "yes";
        onChange({ ...next, explicitPostingConsent: false }); }} />
  );
  return <Stack gap={3}>
    {creator ? <div className="break-words [overflow-wrap:anywhere]">
      <Typography as="h3" variant="heading-3">{creator.nickname} · @{creator.username}</Typography>
      <Typography variant="caption">TikTok permits videos up to {creator.maxDurationSeconds} seconds for this creator. This flow supports up to {Math.min(600, creator.maxDurationSeconds)} seconds.</Typography>
      <Typography variant="caption" tone="muted">Creator settings checked {checkedAt(creator.checkedAt)}.</Typography>
    </div> : <Alert title="TikTok creator settings required" tone="warning" role="note">Refresh this connected creator before choosing privacy or approving a post. Current creator settings are unavailable.</Alert>}
    {onRefresh ? <Button variant="secondary" disabled={disabled} onClick={onRefresh}>Refresh TikTok creator settings</Button> : null}
    {!audited ? <Alert title="TikTok test-only publishing" tone="warning" role="note">This app has not been approved for public scheduling. Test posts require a private TikTok creator account and Only me visibility. Public publishing remains blocked until the intended scheduling flow passes TikTok&apos;s audit.</Alert> : null}
    {privateCreatorRequired ? <Alert title="Private creator account required" tone="warning" role="note">This creator&apos;s current settings allow public visibility. Use a private account for unaudited testing, then refresh its settings.</Alert> : null}
    <Select label="TikTok privacy" placeholder={creator ? "Choose privacy explicitly" : "Fresh creator settings unavailable"} value={privacy}
      disabled={disabled || !creator || !privacyLevels.length} options={privacyLevels.map((level) => ({ label: labels[level] ?? level, value: level }))}
      onChange={(event) => { const next = { ...current }; if (event.target.value) next.privacyLevel = event.target.value; else delete next.privacyLevel;
        if (event.target.value === "SELF_ONLY") { next.brandContentToggle = false; next.musicUsageConsent = false; }
        onChange({ ...next, explicitPostingConsent: false }); }} />
    {bool("disableComment", "Allow TikTok comments", true, creator?.commentDisabled === true)}
    {bool("disableDuet", "Allow TikTok Duet", true, creator?.duetDisabled === true)}
    {bool("disableStitch", "Allow TikTok Stitch", true, creator?.stitchDisabled === true)}
    <Select label="Does this TikTok post promote a brand, product, or service?" value={current.commercialContentDisclosure === true ? "yes" : current.commercialContentDisclosure === false ? "no" : ""}
      placeholder="Choose explicitly" disabled={disabled || !creator} options={[{ label: "Yes", value: "yes" }, { label: "No", value: "no" }]}
      onChange={(event) => { const next: Record<string, unknown> = { ...current, brandContentToggle: false, brandOrganicToggle: false, musicUsageConsent: false, explicitPostingConsent: false };
        if (event.target.value) next.commercialContentDisclosure = event.target.value === "yes"; else delete next.commercialContentDisclosure; onChange(next); }} />
    {commercial ? <>
      <Typography variant="caption">Choose the commercial content disclosure explicitly.</Typography>
      <Checkbox label="My brand" checked={current.brandOrganicToggle === true} disabled={disabled || !creator}
        onChange={(event) => set({ brandOrganicToggle: event.target.checked, musicUsageConsent: false })} />
      <Checkbox label="Branded content for another business" checked={current.brandContentToggle === true} disabled={disabled || !creator || privacy === "SELF_ONLY"}
        description={privacy === "SELF_ONLY" ? "Branded content cannot use private visibility." : undefined}
        onChange={(event) => set({ brandContentToggle: event.target.checked, musicUsageConsent: false })} />
      <Typography variant="caption">{current.brandContentToggle === true ? "The video will carry a Paid partnership label." : current.brandOrganicToggle === true ? "The video will carry a Promotional content label." : "Choose your brand, another business, or both before posting."}</Typography>
    </> : null}
    <Checkbox label={current.brandContentToggle === true ? "I agree to TikTok's Branded Content Policy and Music Usage Confirmation" : "I agree to TikTok's Music Usage Confirmation"}
      checked={current.musicUsageConsent === true} disabled={disabled || !creator || typeof current.commercialContentDisclosure !== "boolean"}
      onChange={(event) => set({ musicUsageConsent: event.target.checked })} />
    <Typography variant="caption">By posting, you agree to TikTok&apos;s {current.brandContentToggle === true ? <><a className="link link-primary" href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">Branded Content Policy</a> and </> : null}<a className="link link-primary" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">Music Usage Confirmation</a>.</Typography>
    {bool("isAigc", "This TikTok video includes AI-generated content")}
    <Typography as="h3" variant="heading-3">Review this exact TikTok video</Typography>
    {video ? <MediaPreview media={[video]} /> : <Typography variant="caption">Choose one inspected video for this TikTok destination before approving posting.</Typography>}
    {video && !videoReady ? <Typography role="status" variant="caption">This video is unavailable or exceeds the creator&apos;s supported duration. Choose an available video within the verified limit.</Typography> : null}
    <Checkbox label={creator ? `I approve posting this exact video and caption to @${creator.username} with the settings shown above` : "I approve posting this exact TikTok video and caption"}
      checked={current.explicitPostingConsent === true && Boolean(ready)} disabled={disabled || !ready}
      description="Changes to content, media, destinations, creator settings or posting choices require new consent. Scheduling still requires approval of the saved revision."
      onChange={(event) => onChange({ ...current, explicitPostingConsent: event.target.checked })} />
  </Stack>;
}
