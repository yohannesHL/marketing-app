// packages/core/src/types.ts
export type Campaign = {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  startDate: Date;
  endDate: Date;
};

export type Ad = {
  id: string;
  campaignId: string;
  name: string;
  creativeUrl: string;
  targetAudience: string[];
  budget: number;
};
