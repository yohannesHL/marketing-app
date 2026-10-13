export type TrackedEntity = {
  id: string;
  type: "campaign" | "asset" | "audience";
  cleanup?: () => Promise<void> | void;
};

export type FactoryTracker = {
  register(entity: TrackedEntity): TrackedEntity;
  snapshot(): TrackedEntity[];
  cleanup(): Promise<void>;
};
