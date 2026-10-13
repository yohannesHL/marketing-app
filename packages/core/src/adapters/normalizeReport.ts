import { UnifiedReport } from "./types";

function normalizeGoogleReport(data: any): UnifiedReport {
  return {
    rows: data.results.map((r: any) => ({
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
    })),
  };
}

function normalizeMetaReport(data: any): UnifiedReport {
  return {
    rows: data.data.map((r: any) => ({
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
    })),
  };
}
