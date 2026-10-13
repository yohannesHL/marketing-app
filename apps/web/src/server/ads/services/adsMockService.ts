// Keep a single secured implementation for both historical mock service entry points.
export {
  executeCreateAssets,
  executeCreateCampaign,
  getPersistedExecution,
} from "./adsProxyService";
