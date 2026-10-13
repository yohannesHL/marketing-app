import * as React from "react";

import { cx } from "../utils";

export interface Step {
  id: string;
  title: string;
  description?: string;
}

export interface StepperProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: Step[];
  currentStep: number;
}

export function Stepper({
  steps,
  currentStep,
  className,
  ...props
}: StepperProps) {
  return (
    <div className={cx("overflow-x-auto", className)} {...props}>
      <div className="flex min-w-max items-center justify-center gap-0">
        {steps.map((step, index) => {
          const state =
            index < currentStep
              ? "complete"
              : index === currentStep
                ? "current"
                : "upcoming";
          const isLast = index === steps.length - 1;
          return (
            <React.Fragment key={step.id}>
              <div className="flex items-center gap-2">
                <div
                  className={cx(
                    "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors",
                    state === "complete" && "bg-primary text-primary-content",
                    state === "current" && "bg-primary text-primary-content",
                    state === "upcoming" && "bg-base-200 text-base-content/60",
                  )}
                >
                  {state === "complete" ? (
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </div>
                <span
                  className={cx(
                    "text-sm font-medium transition-colors",
                    state === "current" && "text-primary",
                    state === "complete" && "text-base-content",
                    state === "upcoming" && "text-base-content/60",
                  )}
                >
                  {step.title}
                </span>
              </div>
              {!isLast && (
                <div
                  className={cx(
                    "mx-3 h-px w-12 shrink-0 transition-colors",
                    index < currentStep ? "bg-primary" : "bg-base-300",
                  )}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
