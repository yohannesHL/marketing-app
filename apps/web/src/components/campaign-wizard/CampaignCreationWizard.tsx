"use client";

import * as React from "react";
import Link from "next/link";

import {
  campaignWizardSteps,
  type CampaignGoal,
  type SupportedPlatform,
} from "@launchpad/core";
import { Alert, Button, Container, Divider, Stack, Stepper } from "@launchpad/ui";

import {
  fetchAudienceEstimate,
  fetchBudgetInsight,
  fetchCreativeSuggestions,
  fetchGoalStrategy,
  fetchPlatformEstimate,
  submitLaunchCampaign,
} from "./api-client";
import { AudienceTargetingStep } from "./AudienceTargetingStep";
import { BudgetStep } from "./BudgetStep";
import { CampaignGoalStep } from "./CampaignGoalStep";
import { CreativeGenerationStep } from "./CreativeGenerationStep";
import { PlatformSelectionStep } from "./PlatformSelectionStep";
import { ReviewLaunchStep } from "./ReviewLaunchStep";
import {
  createPlacementPreviews,
  hasGeneratedCreatives,
  hasStepOneReady,
  initialCampaignWizardFormState,
  initialWizardAsyncState,
  mapCreativeResponseToForm,
  toAudienceTargetingInput,
  toBudgetPlanInput,
  type AudienceFormState,
  type BudgetFormState,
  type CampaignWizardFormState,
  type CreativeFormState,
} from "./state";

const stepDescriptions = [
  "Choose the campaign intent and review the recommended approach.",
  "Define who should see the campaign and validate audience size.",
  "Set expectations for spend and projected reach.",
  "Generate and edit creatives before launch.",
  "Choose the right channel mix with traffic estimates.",
  "Review the full plan and launch with confidence.",
];

const budgetFields = ["dailyBudget", "durationInDays", "totalBudget"] as const;

export function CampaignCreationWizard({ demoEnabled = false }: { demoEnabled?: boolean }) {
  const [currentStepIndex, setCurrentStepIndex] = React.useState(0);
  const [formState, setFormState] = React.useState<CampaignWizardFormState>(
    initialCampaignWizardFormState,
  );
  const [asyncState, setAsyncState] = React.useState(initialWizardAsyncState);
  const [goalStrategyLoading, setGoalStrategyLoading] = React.useState(false);
  const [audienceEstimateLoading, setAudienceEstimateLoading] =
    React.useState(false);
  const [budgetInsightLoading, setBudgetInsightLoading] = React.useState(false);
  const [creativeLoading, setCreativeLoading] = React.useState(false);
  const [platformEstimateLoading, setPlatformEstimateLoading] =
    React.useState(false);
  const [launchLoading, setLaunchLoading] = React.useState(false);
  const [audienceUploadError, setAudienceUploadError] = React.useState<
    string | null
  >(null);
  const lastBudgetEditedRef =
    React.useRef<keyof BudgetFormState>("dailyBudget");

  const previews = React.useMemo(
    () => createPlacementPreviews(formState.creatives),
    [formState.creatives],
  );

  React.useEffect(() => {
    if (!hasStepOneReady(formState.goal)) {
      setAsyncState((previousState) => ({
        ...previousState,
        goalStrategy: null,
        goalStrategyError: null,
      }));
      return;
    }

    let isCurrent = true;
    setGoalStrategyLoading(true);
    setAsyncState((previousState) => ({
      ...previousState,
      goalStrategyError: null,
      launchResult: null,
    }));

    void fetchGoalStrategy(formState.goal)
      .then((goalStrategy) => {
        if (!isCurrent) {
          return;
        }

        setAsyncState((previousState) => ({
          ...previousState,
          goalStrategy,
        }));
      })
      .catch((error: Error) => {
        if (!isCurrent) {
          return;
        }

        setAsyncState((previousState) => ({
          ...previousState,
          goalStrategy: null,
          goalStrategyError: error.message,
        }));
      })
      .finally(() => {
        if (!isCurrent) {
          return;
        }

        setGoalStrategyLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [formState.goal]);

  React.useEffect(() => {
    const goal = hasStepOneReady(formState.goal) ? formState.goal : null;
    const audienceTargeting = goal
      ? toAudienceTargetingInput(formState.audience)
      : null;

    if (goal === null || audienceTargeting === null || audienceUploadError) {
      setAsyncState((previousState) => ({
        ...previousState,
        audienceEstimate: null,
        audienceEstimateError: null,
      }));
      return;
    }

    let isCurrent = true;
    setAudienceEstimateLoading(true);
    const timeoutId = window.setTimeout(() => {
      void fetchAudienceEstimate({
        goal,
        targeting: audienceTargeting,
      })
        .then((audienceEstimate) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            audienceEstimate,
            audienceEstimateError: null,
          }));
        })
        .catch((error: Error) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            audienceEstimate: null,
            audienceEstimateError: error.message,
          }));
        })
        .finally(() => {
          if (!isCurrent) {
            return;
          }

          setAudienceEstimateLoading(false);
        });
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [audienceUploadError, formState.goal, formState.audience]);

  React.useEffect(() => {
    const budgetPlan = hasStepOneReady(formState.goal)
      ? toBudgetPlanInput(formState.goal, formState.budget)
      : null;

    if (budgetPlan === null) {
      setAsyncState((previousState) => ({
        ...previousState,
        budgetInsight: null,
        budgetInsightError: null,
      }));
      return;
    }

    let isCurrent = true;
    setBudgetInsightLoading(true);
    const timeoutId = window.setTimeout(() => {
      void fetchBudgetInsight(budgetPlan)
        .then((budgetInsight) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            budgetInsight,
            budgetInsightError: null,
          }));
        })
        .catch((error: Error) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            budgetInsight: null,
            budgetInsightError: error.message,
          }));
        })
        .finally(() => {
          if (!isCurrent) {
            return;
          }

          setBudgetInsightLoading(false);
        });
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [formState.goal, formState.budget]);

  React.useEffect(() => {
    const goal = hasStepOneReady(formState.goal) ? formState.goal : null;

    if (
      goal === null ||
      formState.selectedPlatforms.length === 0 ||
      formState.budget.totalBudget.trim().length === 0
    ) {
      setAsyncState((previousState) => ({
        ...previousState,
        platformEstimate: null,
        platformEstimateError: null,
      }));
      return;
    }

    const totalBudget = Number.parseInt(formState.budget.totalBudget, 10);

    if (!Number.isFinite(totalBudget) || totalBudget <= 0) {
      return;
    }

    let isCurrent = true;
    setPlatformEstimateLoading(true);
    const timeoutId = window.setTimeout(() => {
      void fetchPlatformEstimate({
        goal,
        totalBudget,
        selectedPlatforms: formState.selectedPlatforms,
      })
        .then((platformEstimate) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            platformEstimate,
            platformEstimateError: null,
          }));
        })
        .catch((error: Error) => {
          if (!isCurrent) {
            return;
          }

          setAsyncState((previousState) => ({
            ...previousState,
            platformEstimate: null,
            platformEstimateError: error.message,
          }));
        })
        .finally(() => {
          if (!isCurrent) {
            return;
          }

          setPlatformEstimateLoading(false);
        });
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    formState.goal,
    formState.budget.totalBudget,
    formState.selectedPlatforms,
  ]);

  const currentStepTitle = campaignWizardSteps[currentStepIndex];
  const canContinue = getCanContinue({
    currentStepIndex,
    formState,
    audienceUploadError,
    asyncState,
  });

  const handleAudienceFieldChange = <Field extends keyof AudienceFormState>(
    field: Field,
    value: AudienceFormState[Field],
  ) => {
    setFormState((previousState) => ({
      ...previousState,
      audience: {
        ...previousState.audience,
        [field]: value,
      },
    }));
  };

  const handleBudgetChange = (
    field: keyof BudgetFormState,
    rawValue: string,
  ) => {
    const sanitizedValue = rawValue.replace(/[^\d]/g, "");
    const previousLastEdited = lastBudgetEditedRef.current;
    lastBudgetEditedRef.current = field;

    setFormState((previousState) => ({
      ...previousState,
      budget: reconcileBudget(
        {
          ...previousState.budget,
          [field]: sanitizedValue,
        },
        field,
        previousLastEdited,
      ),
    }));
  };

  const handleCreativesChange = (creatives: CreativeFormState) => {
    setFormState((previousState) => ({
      ...previousState,
      creatives,
    }));
  };

  const handleCampaignNameChange = (name: string) => {
    setFormState((previousState) => ({
      ...previousState,
      campaignName: name,
    }));
  };

  const handleGoalChange = (goal: CampaignGoal) => {
    setFormState((previousState) => ({
      ...previousState,
      goal,
    }));
  };

  const handleAudienceUpload = (file: File | null) => {
    if (file === null) {
      setAudienceUploadError(null);
      setFormState((previousState) => ({
        ...previousState,
        audience: {
          ...previousState.audience,
          customAudienceFileName: null,
        },
      }));
      return;
    }

    const isAllowedType =
      file.name.endsWith(".csv") || file.name.endsWith(".txt");
    const isAllowedSize = file.size <= 5 * 1024 * 1024;

    if (!isAllowedType || !isAllowedSize) {
      setAudienceUploadError("Upload a CSV or TXT audience file under 5 MB.");
      setFormState((previousState) => ({
        ...previousState,
        audience: {
          ...previousState.audience,
          customAudienceFileName: null,
        },
      }));
      return;
    }

    setAudienceUploadError(null);
    setFormState((previousState) => ({
      ...previousState,
      audience: {
        ...previousState.audience,
        customAudienceFileName: file.name,
      },
    }));
  };

  const handleGenerateCreatives = async () => {
    const goal = hasStepOneReady(formState.goal) ? formState.goal : null;

    if (goal === null) {
      return;
    }

    const audience = toAudienceTargetingInput(formState.audience);
    const budget = toBudgetPlanInput(goal, formState.budget);

    if (audience === null || budget === null) {
      return;
    }

    setCreativeLoading(true);
    setAsyncState((previousState) => ({
      ...previousState,
      creativeError: null,
      launchResult: null,
    }));

    try {
      const creativeResponse = await fetchCreativeSuggestions({
        goal,
        audience,
        budget,
      });

      setFormState((previousState) => ({
        ...previousState,
        creatives: mapCreativeResponseToForm(creativeResponse),
      }));
    } catch (error) {
      setAsyncState((previousState) => ({
        ...previousState,
        creativeError:
          error instanceof Error
            ? error.message
            : "Unable to generate creatives.",
      }));
    } finally {
      setCreativeLoading(false);
    }
  };

  const handleTogglePlatform = (
    platform: SupportedPlatform,
    enabled: boolean,
  ) => {
    setFormState((previousState) => ({
      ...previousState,
      selectedPlatforms: enabled
        ? [...new Set([...previousState.selectedPlatforms, platform])]
        : previousState.selectedPlatforms.filter((entry) => entry !== platform),
    }));
  };

  const handleLaunchCampaign = async () => {
    if (!demoEnabled) return;
    if (
      !hasStepOneReady(formState.goal) ||
      toAudienceTargetingInput(formState.audience) === null ||
      toBudgetPlanInput(formState.goal, formState.budget) === null ||
      formState.selectedPlatforms.length === 0 ||
      !hasGeneratedCreatives(formState.creatives)
    ) {
      return;
    }

    setLaunchLoading(true);
    setAsyncState((previousState) => ({
      ...previousState,
      launchError: null,
      launchResult: null,
    }));

    try {
      const launchResult = await submitLaunchCampaign(formState);
      setAsyncState((previousState) => ({
        ...previousState,
        launchResult: {
          message: launchResult.message,
          launchId: launchResult.launchId,
          uniformPayload: launchResult.uniformPayload,
          platformsInvoked: launchResult.platformsInvoked,
        },
      }));
    } catch (error) {
      setAsyncState((previousState) => ({
        ...previousState,
        launchError:
          error instanceof Error ? error.message : "Unable to submit launch.",
      }));
    } finally {
      setLaunchLoading(false);
    }
  };

  return (
    <main className="py-8" data-testid="campaign-wizard">
      <Container>
        <Stack gap={8}>
          <Alert title={demoEnabled ? "Advertising demo" : "Campaign publishing unavailable"} tone="info">
            {demoEnabled
              ? "This wizard runs simulated advertising requests. It does not create or activate ads in customer accounts."
              : "Connect and check your accounts in settings. Campaign publishing will be available after provider validation."}
            {" "}<Link className="underline" href="/connections">Manage customer connections</Link>
          </Alert>
          <Stepper
            currentStep={currentStepIndex}
            steps={campaignWizardSteps.map((step, index) => ({
              id: step.toLowerCase().replace(/\s+/g, "-"),
              title: step
                .replace(" and ", " & ")
                .replace("Ad Creative Generation", "Creatives")
                .replace("Platform Selection", "Platforms")
                .replace("Audience Targeting", "Audience")
                .replace("Review and Launch", "Review"),
            }))}
          />

          <div className="min-h-[400px]">
            <div data-testid="campaign-step-title" className="sr-only">
              {currentStepTitle}
            </div>
            {renderStep({
              currentStepIndex,
              formState,
              asyncState,
              audienceUploadError,
              previews,
              goalStrategyLoading,
              audienceEstimateLoading,
              budgetInsightLoading,
              creativeLoading,
              platformEstimateLoading,
              launchLoading,
              onCampaignNameChange: handleCampaignNameChange,
              onGoalChange: handleGoalChange,
              onAudienceFieldChange: handleAudienceFieldChange,
              onAudienceUpload: handleAudienceUpload,
              onBudgetChange: handleBudgetChange,
              onGenerateCreatives: handleGenerateCreatives,
              onCreativesChange: handleCreativesChange,
              onTogglePlatform: handleTogglePlatform,
              onLaunchCampaign: handleLaunchCampaign,
            })}
          </div>

          <Divider />

          <WizardFooter
            demoEnabled={demoEnabled}
            canContinue={canContinue}
            currentStepIndex={currentStepIndex}
            isLastStep={currentStepIndex === campaignWizardSteps.length - 1}
            isLaunching={launchLoading}
            onBack={() =>
              setCurrentStepIndex((index) => Math.max(0, index - 1))
            }
            onContinue={() =>
              setCurrentStepIndex((index) =>
                Math.min(campaignWizardSteps.length - 1, index + 1),
              )
            }
            onLaunch={handleLaunchCampaign}
          />
        </Stack>
      </Container>
    </main>
  );
}

function WizardFooter({
  demoEnabled,
  currentStepIndex,
  canContinue,
  isLastStep,
  isLaunching,
  onBack,
  onContinue,
  onLaunch,
}: {
  demoEnabled: boolean;
  currentStepIndex: number;
  canContinue: boolean;
  isLastStep: boolean;
  isLaunching: boolean;
  onBack: () => void;
  onContinue: () => void;
  onLaunch: () => Promise<void>;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <Button
        disabled={currentStepIndex === 0}
        onClick={onBack}
        variant="ghost"
        leadingIcon={
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              d="M19 12H5M12 19l-7-7 7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
      >
        {currentStepIndex === 0 ? "Dashboard" : "Back"}
      </Button>
      {isLastStep ? (
        <Button
          disabled={!demoEnabled}
          onClick={() => void onLaunch()}
          loading={isLaunching}
          leadingIcon={
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                d="M5 12h14M12 5l7 7-7 7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
        >
          Launch Campaign
        </Button>
      ) : (
        <Button
          disabled={!canContinue}
          onClick={onContinue}
          trailingIcon={
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                d="M5 12h14M12 5l7 7-7 7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
        >
          Continue
        </Button>
      )}
    </div>
  );
}

function renderStep({
  currentStepIndex,
  formState,
  asyncState,
  audienceUploadError,
  previews,
  goalStrategyLoading,
  audienceEstimateLoading,
  budgetInsightLoading,
  creativeLoading,
  platformEstimateLoading,
  launchLoading,
  onCampaignNameChange,
  onGoalChange,
  onAudienceFieldChange,
  onAudienceUpload,
  onBudgetChange,
  onGenerateCreatives,
  onCreativesChange,
  onTogglePlatform,
  onLaunchCampaign,
}: {
  currentStepIndex: number;
  formState: CampaignWizardFormState;
  asyncState: typeof initialWizardAsyncState;
  audienceUploadError: string | null;
  previews: ReturnType<typeof createPlacementPreviews>;
  goalStrategyLoading: boolean;
  audienceEstimateLoading: boolean;
  budgetInsightLoading: boolean;
  creativeLoading: boolean;
  platformEstimateLoading: boolean;
  launchLoading: boolean;
  onCampaignNameChange: (name: string) => void;
  onGoalChange: (goal: CampaignGoal) => void;
  onAudienceFieldChange: <Field extends keyof AudienceFormState>(
    field: Field,
    value: AudienceFormState[Field],
  ) => void;
  onAudienceUpload: (file: File | null) => void;
  onBudgetChange: (field: keyof BudgetFormState, value: string) => void;
  onGenerateCreatives: () => Promise<void>;
  onCreativesChange: (creatives: CreativeFormState) => void;
  onTogglePlatform: (platform: SupportedPlatform, enabled: boolean) => void;
  onLaunchCampaign: () => Promise<void>;
}) {
  switch (currentStepIndex) {
    case 0:
      return (
        <CampaignGoalStep
          campaignName={formState.campaignName}
          error={asyncState.goalStrategyError}
          goal={formState.goal}
          goalStrategy={asyncState.goalStrategy}
          isLoading={goalStrategyLoading}
          onCampaignNameChange={onCampaignNameChange}
          onGoalChange={onGoalChange}
        />
      );
    case 1:
      return (
        <AudienceTargetingStep
          audience={formState.audience}
          estimate={asyncState.audienceEstimate}
          estimateError={asyncState.audienceEstimateError}
          isLoading={audienceEstimateLoading}
          onAudienceUpload={onAudienceUpload}
          onFieldChange={onAudienceFieldChange}
          uploadError={audienceUploadError}
        />
      );
    case 2:
      return (
        <BudgetStep
          budget={formState.budget}
          error={asyncState.budgetInsightError}
          insight={asyncState.budgetInsight}
          isLoading={budgetInsightLoading}
          onBudgetChange={onBudgetChange}
        />
      );
    case 3:
      return (
        <CreativeGenerationStep
          creatives={formState.creatives}
          error={asyncState.creativeError}
          isLoading={creativeLoading}
          onCreativesChange={onCreativesChange}
          onGenerate={onGenerateCreatives}
          previews={previews}
        />
      );
    case 4:
      return (
        <PlatformSelectionStep
          error={asyncState.platformEstimateError}
          estimate={asyncState.platformEstimate}
          isLoading={platformEstimateLoading}
          onTogglePlatform={onTogglePlatform}
          selectedPlatforms={formState.selectedPlatforms}
        />
      );
    case 5:
      return (
        <ReviewLaunchStep
          audienceEstimate={asyncState.audienceEstimate}
          budgetInsight={asyncState.budgetInsight}
          form={formState}
          isLaunching={launchLoading}
          launchError={asyncState.launchError}
          launchResult={asyncState.launchResult}
          onLaunch={onLaunchCampaign}
          platformEstimate={asyncState.platformEstimate}
        />
      );
    default:
      return null;
  }
}

function getCanContinue({
  currentStepIndex,
  formState,
  audienceUploadError,
  asyncState,
}: {
  currentStepIndex: number;
  formState: CampaignWizardFormState;
  audienceUploadError: string | null;
  asyncState: typeof initialWizardAsyncState;
}) {
  switch (currentStepIndex) {
    case 0:
      return hasStepOneReady(formState.goal);
    case 1:
      return (
        toAudienceTargetingInput(formState.audience) !== null &&
        audienceUploadError === null
      );
    case 2:
      return (
        hasStepOneReady(formState.goal) &&
        toBudgetPlanInput(formState.goal, formState.budget) !== null
      );
    case 3:
      return hasGeneratedCreatives(formState.creatives);
    case 4:
      return formState.selectedPlatforms.length > 0;
    default:
      return false;
  }
}

function reconcileBudget(
  budget: BudgetFormState,
  field: keyof BudgetFormState,
  previousLastEdited: keyof BudgetFormState,
): BudgetFormState {
  const nextBudget = { ...budget };
  const dailyBudget = parseBudgetValue(nextBudget.dailyBudget);
  const durationInDays = parseBudgetValue(nextBudget.durationInDays);
  const totalBudget = parseBudgetValue(nextBudget.totalBudget);

  if (
    field === "dailyBudget" &&
    dailyBudget !== null &&
    durationInDays !== null
  ) {
    nextBudget.totalBudget = String(dailyBudget * durationInDays);
  }

  if (
    field === "totalBudget" &&
    totalBudget !== null &&
    durationInDays !== null
  ) {
    nextBudget.dailyBudget = String(Math.round(totalBudget / durationInDays));
  }

  if (field === "durationInDays" && durationInDays !== null) {
    if (previousLastEdited === "totalBudget" && totalBudget !== null) {
      nextBudget.dailyBudget = String(Math.round(totalBudget / durationInDays));
    } else if (dailyBudget !== null) {
      nextBudget.totalBudget = String(dailyBudget * durationInDays);
    }
  }

  return nextBudget;
}

function parseBudgetValue(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  return parsedValue > 0 ? parsedValue : null;
}
