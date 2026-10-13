import { CampaignObjective } from "./types";

export function mapTikTokObjective(objective: CampaignObjective): string {
  switch (objective) {
    case "CONVERSIONS":
      return "CONVERSIONS";
    case "CLICKS":
      return "TRAFFIC";
    case "AWARENESS":
      return "REACH";
    case "LEADS":
      return "LEAD_GENERATION";
    case "APP_INSTALLS":
      return "APP_INSTALL";
    default:
      throw new Error(`Unsupported objective for TikTok: ${objective}`);
  }
}

export function mapMetaObjective(objective: CampaignObjective): string {
  switch (objective) {
    case "CONVERSIONS":
      return "OUTCOME_SALES";
    case "CLICKS":
      return "OUTCOME_TRAFFIC";
    case "AWARENESS":
      return "OUTCOME_AWARENESS";
    case "LEADS":
      return "OUTCOME_LEADS";
    case "APP_INSTALLS":
      return "OUTCOME_APP_PROMOTION";
    default:
      throw new Error(`Unsupported Meta objective: ${objective}`);
  }
}

export function mapGoogleObjective(objective: CampaignObjective): string {
  switch (objective) {
    case "CONVERSIONS":
      return "PERFORMANCE_MAX";
    case "CLICKS":
      return "SEARCH";
    case "AWARENESS":
      return "DISPLAY";
    case "APP_INSTALLS":
      return "APP";
    default:
      throw new Error(`Unsupported Google objective: ${objective}`);
  }
}
