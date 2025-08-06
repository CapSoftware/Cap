import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faCheck, faRefresh } from "@fortawesome/free-solid-svg-icons";
import { useReducer, Fragment, useState, useEffect, useRef } from "react";
import clsx from "clsx";
import { checkOrganizationDomain } from "@/actions/organization/check-domain";

import { motion } from "motion/react";
import { Check, CheckCircle, Copy, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import { updateDomain } from "@/actions/organization/update-domain";
import { useRouter } from "next/navigation";

// Types and Enums
enum StepStatus {
  PENDING = 'pending',
  CURRENT = 'current',
  COMPLETED = 'completed'
}

interface StepConfig {
  id: string;
  name: string;
  description?: string;
}

interface StepState {
  currentIndex: number;
  totalSteps: number;
  canNavigateBack: boolean;
  errors: Record<string, string>;
}

type StepAction =
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' }
  | { type: 'GO_TO_STEP'; payload: number }
  | { type: 'SET_ERROR'; payload: { stepId: string; error: string } }
  | { type: 'CLEAR_ERROR'; payload: string }
  | { type: 'RESET' };

type DomainVerification = {
  type: string;
  domain: string;
  value: string;
  reason: string;
};

type DomainConfig = {
  name: string;
  apexName: string;
  verification: DomainVerification[];
  verified: boolean;
  misconfigured?: boolean;
  aValues?: string[];
  currentAValues?: string[];
  requiredAValue?: string;
};

const STEP_CONFIGS: StepConfig[] = [
  {
    id: 'domain',
    name: 'Domain',
    description: 'Enter your custom domain'
  },
  {
    id: 'verify',
    name: 'Verify',
    description: 'Verify domain ownership'
  },
  {
    id: 'success',
    name: 'Success',
    description: 'Domain setup complete'
  }
];

// Reducer
const stepReducer = (state: StepState, action: StepAction): StepState => {
  switch (action.type) {
    case 'NEXT_STEP':
      return {
        ...state,
        currentIndex: Math.min(state.currentIndex + 1, state.totalSteps - 1),
        errors: {} // Clear errors when moving forward
      };

    case 'PREV_STEP':
      return {
        ...state,
        currentIndex: Math.max(state.currentIndex - 1, 0),
        errors: {}
      };

    case 'GO_TO_STEP':
      const targetIndex = action.payload;
      const canNavigate = targetIndex <= state.currentIndex || state.canNavigateBack;

      return canNavigate ? {
        ...state,
        currentIndex: Math.max(0, Math.min(targetIndex, state.totalSteps - 1)),
        errors: {}
      } : state;

    case 'SET_ERROR':
      return {
        ...state,
        errors: {
          ...state.errors,
          [action.payload.stepId]: action.payload.error
        }
      };

    case 'CLEAR_ERROR':
      const newErrors = { ...state.errors };
      delete newErrors[action.payload];
      return {
        ...state,
        errors: newErrors
      };

    case 'RESET':
      return {
        ...state,
        currentIndex: 0,
        errors: {}
      };

    default:
      return state;
  }
};

// Main Dialog Component
interface CustomDomainDialogProps {
  open: boolean;
  onClose: () => void;
  onVerifyDomain?: () => Promise<void>;
}

const CustomDomainDialog = ({
  open,
  onClose,
  onVerifyDomain,
}: CustomDomainDialogProps) => {
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [domain, setDomain] = useState(
    activeOrganization?.organization.customDomain || ""
  );
  const [isVerified, setIsVerified] = useState(
    !!activeOrganization?.organization.domainVerified
  );
  const [verifying, setVerifying] = useState(false);
  const [domainConfig, setDomainConfig] = useState<DomainConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();


  const [stepState, dispatch] = useReducer(stepReducer, {
    currentIndex: 0,
    totalSteps: STEP_CONFIGS.length,
    canNavigateBack: true,
    errors: {}
  });

  const pollInterval = useRef<NodeJS.Timeout>();
  const POLL_INTERVAL = 5000;

  const checkVerification = async (showToasts = true) => {
    if (
      !activeOrganization?.organization.id ||
      !activeOrganization?.organization.customDomain
    )
      return;
    setVerifying(true);

    try {
      const data = await checkOrganizationDomain(
        activeOrganization.organization.id
      );

      setIsVerified(data.verified);
      setDomainConfig(data.config);

      if (showToasts) {
        if (data.verified) {
          toast.success("Domain is verified!");

          if (pollInterval.current) {
            clearInterval(pollInterval.current);
            pollInterval.current = undefined;
          }
        } else {
          toast.error(
            "Domain is not verified. Please check your DNS settings."
          );
        }
      }
    } catch (error) {
      if (showToasts) {
        toast.error("Failed to check domain verification");
      }
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    if (activeOrganization?.organization.customDomain && !isVerified) {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
      }

      checkVerification(false);

      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    }

    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = undefined;
      }
    };
  }, [activeOrganization?.organization.customDomain, isVerified]);

  const steps = STEP_CONFIGS.map((config, index) => ({
    ...config,
    status: index < stepState.currentIndex ? StepStatus.COMPLETED :
      index === stepState.currentIndex ? StepStatus.CURRENT :
        StepStatus.PENDING,
    hasError: !!stepState.errors[config.id]
  }));

  const currentStep = steps[stepState.currentIndex];
  const canGoNext = stepState.currentIndex < STEP_CONFIGS.length - 1;
  const canGoPrev = stepState.currentIndex > 0;

  if (!currentStep) {
    return null;
  }

  // Step navigation handlers
  const handleNext = () => {
    if (canGoNext) {
      dispatch({ type: 'NEXT_STEP' });
    }
  };

  const handlePrev = () => {
    if (canGoPrev) {
      dispatch({ type: 'PREV_STEP' });
    }
  };

  const handleStepClick = (index: number) => {
    dispatch({ type: 'GO_TO_STEP', payload: index });
  };

  const handleReset = () => {
    dispatch({ type: 'RESET' });
    setDomain('');
  };

  // Step-specific handlers
  const handleDomainSubmit = async () => {
    if (!domain.trim()) {
      dispatch({
        type: 'SET_ERROR',
        payload: { stepId: 'domain', error: 'Domain is required' }
      });
      return;
    }

    const cleanDomain = (input: string) => {
      if (!input) return "";

      if (input === "cap.so" || input === "cap.link") {
        return "";
      }

      const withoutProtocol = input.replace(/^(https?:\/\/)?(www\.)?/i, "");
      const parts = withoutProtocol.split("/");
      const domain = parts[0] || "";
      const withoutQuery = domain.split("?")[0] || "";
      const withoutHash = withoutQuery.split("#")[0] || "";
      const cleanedDomain = withoutHash.trim();

      const hasTLD =
        /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(
          cleanedDomain
        );

      return hasTLD ? cleanedDomain : "";
    };

    const cleanedDomain = cleanDomain(domain);
    if (!cleanedDomain) {
      dispatch({
        type: 'SET_ERROR',
        payload: { stepId: 'domain', error: 'Please enter a valid domain' }
      });
      return;
    }

    dispatch({ type: 'CLEAR_ERROR', payload: 'domain' });

    setLoading(true);
    setDomain(cleanedDomain);

    try {
      const data = await updateDomain(
        cleanedDomain,
        activeOrganization?.organization.id as string
      );

      toast.success("Domain settings updated");
      router.refresh();

      setDomainConfig(data.status);
      setIsVerified(data.verified);

      setTimeout(() => {
        checkVerification(false);
      }, 1000);

      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    } catch (error) {
      console.error("Error updating domain:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to update domain settings"
      );
    } finally {
      setLoading(false);
    }

    handleNext();
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };



  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="p-0 w-[calc(100%-20px)] max-w-[600px] rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faGlobe} />}
          description="Let's get you setup with your custom domain for your caps."
        >
          <DialogTitle className="text-lg text-gray-12">
            Custom Domain
          </DialogTitle>
        </DialogHeader>

        <Stepper
          steps={steps}
          currentIndex={stepState.currentIndex}
          onStepClick={handleStepClick}
        />

        <div className="p-5">
          {/* Domain Step */}
          {currentStep.id === 'domain' && (
            <DomainStep
              domain={domain}
              setDomain={setDomain}
              onSubmit={handleDomainSubmit}
              loading={loading}
              error={stepState.errors.domain}
              onClearError={() => dispatch({ type: 'CLEAR_ERROR', payload: 'domain' })}
            />
          )}

          {/* Verify Step */}
          {currentStep.id === 'verify' && (
            <VerifyStep
              domain={domain}
              domainConfig={domainConfig}
              isVerified={isVerified}
              onVerifyDomain={onVerifyDomain}
              verifying={verifying}
              onNext={handleNext}
              onPrev={handlePrev}
            />
          )}

          {/* Success Step */}
          {currentStep.id === 'success' && (
            <div className="py-8 text-center">
              <p className="text-gray-11">Success step - implement your success logic here</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Individual Step Components
interface DomainStepProps {
  domain: string;
  setDomain: (domain: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error?: string;
  onClearError: () => void;
}

const DomainStep = ({ domain, setDomain, onSubmit, loading, error, onClearError }: DomainStepProps) => {
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDomain(e.target.value);
    if (error) {
      onClearError();
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-12">Your domain</h3>
        <p className="text-sm text-gray-11">
          Enter the custom domain you'd like to use for your caps
        </p>
      </div>

      <div className="space-y-3">
        <Input
          type="text"
          id="customDomain"
          placeholder="your-domain.com"
          value={domain}
          className={clsx(
            "max-w-[400px] mx-auto",
            error && "border-red-500 focus:border-red-500"
          )}
          onChange={handleInputChange}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
        {error && (
          <p className="text-sm text-center text-red-500">{error}</p>
        )}
      </div>

      <Button
        onClick={onSubmit}
        size="sm"
        spinner={loading}
        disabled={loading || !domain.trim()}
        variant="dark"
        className="min-w-[100px] mx-auto"
      >
        Next
      </Button>
    </div>
  );
};

// Verify Step Component
interface VerifyStepProps {
  domain: string;
  domainConfig?: DomainConfig | null;
  isVerified?: boolean;
  onVerifyDomain?: () => Promise<void>;
  verifying?: boolean;
  onNext: () => void;
  onPrev: () => void;
}

const VerifyStep = ({
  domain,
  domainConfig,
  isVerified,
  onVerifyDomain,
  verifying,
  onNext,
  onPrev
}: VerifyStepProps) => {
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);

  const handleCopy = async (text: string, field: "name" | "value") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
      toast.success("Copied to clipboard");
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleVerifyClick = async () => {
    if (onVerifyDomain) {
      await onVerifyDomain();
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-12">Verify your domain</h3>
        <p className="text-sm text-gray-11">
          Add the DNS records below to verify ownership of {domain}
        </p>
      </div>

      {/* Verification Status */}
      <div className="flex justify-center">
        {isVerified ? (
          <div className="flex gap-2 items-center px-3 py-2 text-sm text-white bg-green-600 rounded-full">
            <CheckCircle className="size-4" />
            <span className="text-sm font-medium text-white">Domain verified</span>
          </div>
        ) : (
          <div className="flex gap-2 items-center px-3 py-2 text-sm text-white bg-red-500 rounded-full">
            <XCircle className="size-4" />
            <span className="text-sm font-medium text-white">Domain not verified</span>
          </div>
        )}
      </div>

      {/* DNS Configuration */}
      {!isVerified && domainConfig && (
        <div className="space-y-4">
          {/* TXT Record Configuration */}
          {domainConfig.verification?.[0] && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  DNS Configuration Required
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  To verify your domain ownership, add the following TXT record to your DNS configuration:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Type</dt>
                    <dd className="text-sm text-gray-10">
                      {domainConfig.verification[0].type}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Name</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                        <code className="text-xs truncate">
                          {domainConfig.verification[0].domain}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy(domainConfig.verification[0].domain, "name")}
                          className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                          title="Copy to clipboard"
                        >
                          {copiedField === "name" ? (
                            <Check className="size-3.5 text-green-500" />
                          ) : (
                            <Copy className="size-3.5 text-gray-10" />
                          )}
                        </button>
                      </div>
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Value</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex flex-1 gap-1 justify-between items-center px-2 py-1 min-w-0 rounded-lg border bg-gray-4 border-gray-6">
                        <code className="font-mono text-xs break-all">
                          {domainConfig.verification[0].value}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy(domainConfig.verification[0].value, "value")}
                          className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                          title="Copy to clipboard"
                        >
                          {copiedField === "value" ? (
                            <Check className="size-3.5 text-green-500" />
                          ) : (
                            <Copy className="size-3.5 text-gray-10" />
                          )}
                        </button>
                      </div>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {/* A Record Configuration */}
          {!domainConfig.verification?.[0] && domainConfig.requiredAValue && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  DNS Configuration Required
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  To verify your domain ownership, add the following A record to your DNS configuration:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  {domainConfig.currentAValues && domainConfig.currentAValues.length > 0 && (
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Current</dt>
                      <dd className="space-y-1.5 text-sm text-gray-10">
                        {domainConfig.currentAValues.map((value, index) => (
                          <div
                            key={index}
                            className={clsx(
                              value === domainConfig.requiredAValue
                                ? "flex items-center gap-2 text-green-300"
                                : "flex items-center gap-2 text-red-200"
                            )}
                          >
                            <code
                              className={clsx(
                                value === domainConfig.requiredAValue
                                  ? "px-2 py-1 rounded-lg bg-green-900"
                                  : "px-2 py-1 rounded-lg bg-red-900",
                                "text-xs"
                              )}
                            >
                              {value}
                            </code>
                            {value === domainConfig.requiredAValue && (
                              <span className="text-xs text-green-600">(Correct)</span>
                            )}
                          </div>
                        ))}
                      </dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Required</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                        <code className="text-xs text-gray-10">
                          {domainConfig.requiredAValue || "Loading..."}
                        </code>
                        {domainConfig.requiredAValue && (
                          <button
                            type="button"
                            onClick={() =>
                              domainConfig.requiredAValue &&
                              handleCopy(domainConfig.requiredAValue, "value")
                            }
                            className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                            title="Copy to clipboard"
                          >
                            {copiedField === "value" ? (
                              <Check className="size-3.5 text-green-500" />
                            ) : (
                              <Copy className="size-3.5 text-gray-10" />
                            )}
                          </button>
                        )}
                      </div>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-4 justify-between items-center">
        <Button
          type="button"
          variant="gray"
          size="sm"
          onClick={onPrev}
          className="min-w-[100px]"
        >
          Back
        </Button>

        <div className="flex gap-3">
          <Button
            type="button"
            variant="gray"
            size="sm"
            onClick={handleVerifyClick}
            disabled={verifying}
            className="min-w-[120px]"
          >
            {verifying ? (
              <FontAwesomeIcon className="mr-1 animate-spin size-4" icon={faRefresh} />
            ) : (
              <FontAwesomeIcon className="mr-1 size-4" icon={faRefresh} />
            )}
            Check Status
          </Button>

          {isVerified && (
            <Button
              onClick={onNext}
              size="sm"
              variant="dark"
              className="min-w-[100px]"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// Enhanced Stepper Component
interface StepperProps {
  steps: Array<{
    id: string;
    name: string;
    status: StepStatus;
    hasError?: boolean;
  }>;
  currentIndex: number;
  onStepClick?: (index: number) => void;
}

const Stepper = ({ steps, currentIndex, onStepClick }: StepperProps) => {
  return (
    <div className="flex justify-center items-center px-7 py-3 w-full border-b bg-gray-1 border-gray-4">
      {steps.map((step, index) => (
        <Fragment key={step.id}>
          <div
            className={clsx(
              "flex gap-2 items-center",
              onStepClick &&
              step.status === StepStatus.COMPLETED &&
              "cursor-pointer hover:opacity-80 transition-opacity"
            )}
            onClick={() => onStepClick && step.status === StepStatus.COMPLETED && onStepClick(index)}
          >
            <div
              className={clsx(
                "flex justify-center items-center rounded-full border size-5 transition-colors duration-200",
                step.status === StepStatus.COMPLETED && "bg-green-500 border-green-500",
                step.hasError ? "border-red-500 bg-red-500" :
                  step.status !== StepStatus.PENDING
                    ? "border-transparent bg-blue-9"
                    : "bg-transparent border-gray-5"
              )}
            >
              {step.hasError ? (
                <span className="text-white text-[10px]">!</span>
              ) : step.status === StepStatus.COMPLETED ? (
                <FontAwesomeIcon icon={faCheck} className="text-white text-[8px]" />
              ) : (
                <p className={clsx(
                  "text-[11px]",
                  step.status !== StepStatus.PENDING ? "text-white" : "text-gray-10"
                )}>
                  {index + 1}
                </p>
              )}
            </div>
            <p className={clsx(
              "whitespace-nowrap transition-colors duration-200 text-[13px]",
              step.hasError ? "text-red-600" :
                step.status !== StepStatus.PENDING ? "text-gray-12" : "text-gray-10"
            )}>
              {step.name}
            </p>
          </div>
          {index !== steps.length - 1 && (
            <div className="relative flex-1 mx-5 h-[2px] border-t border-dashed border-gray-5">
              <motion.div
                initial={{ width: step.status === StepStatus.COMPLETED ? "100%" : 0 }}
                animate={{ width: step.status === StepStatus.COMPLETED ? "100%" : 0 }}
                transition={{ duration: 0.3 }}
                className="absolute left-0 -top-px z-10 h-full bg-gray-12"
              />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
};

export default CustomDomainDialog;
