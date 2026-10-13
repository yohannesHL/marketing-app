"use client";
import { Input, Select, Stack, Typography } from "@launchpad/ui";
import {
  localTimeInput,
  scheduleInstants,
  utcTime,
  validTimeZone,
} from "./socialTime";
export function initialTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
export function SocialSchedule({
  zone,
  localTime,
  chosen,
  onZone,
  onTime,
  onChosen,
  disabled = false,
}: {
  zone: string;
  localTime: string;
  chosen: string;
  onZone: (zone: string) => void;
  onTime: (time: string) => void;
  onChosen: (instant: string) => void;
  disabled?: boolean;
}) {
  const instants = scheduleInstants(localTime, zone),
    resolved =
      instants.length === 1
        ? instants[0]
        : instants.includes(chosen)
          ? chosen
          : "";
  return (
    <Stack gap={3}>
      <Input
        label="IANA time zone"
        description="For example Europe/London, America/New_York, or UTC."
        value={zone}
        disabled={disabled}
        onChange={(e) => {
          onZone(e.target.value);
          onChosen("");
        }}
        error={
          !validTimeZone(zone) ? "Choose a valid IANA time zone." : undefined
        }
      />
      <Input
        label="Publication date and time"
        type="datetime-local"
        value={localTime}
        disabled={disabled}
        onChange={(e) => {
          onTime(e.target.value);
          onChosen("");
        }}
        error={
          localTime && validTimeZone(zone) && !instants.length
            ? "This local time does not exist. Choose another time."
            : undefined
        }
      />
      {instants.length > 1 ? (
        <Select
          label="Daylight-saving time choice"
          description="The clocks repeat this local time. Choose its exact UTC instant."
          placeholder="Choose an occurrence"
          value={chosen}
          options={instants.map((instant, index) => ({
            value: instant,
            label: `${index === 0 ? "Earlier" : "Later"} occurrence · ${utcTime(instant)}`,
          }))}
          disabled={disabled}
          onChange={(e) => onChosen(e.target.value)}
        />
      ) : null}
      <Typography variant="caption" role="status">
        {utcTime(resolved)}
      </Typography>
    </Stack>
  );
}
export function futureLocalTime(zone: string) {
  return localTimeInput(new Date(Date.now() + 3600000), zone);
}
