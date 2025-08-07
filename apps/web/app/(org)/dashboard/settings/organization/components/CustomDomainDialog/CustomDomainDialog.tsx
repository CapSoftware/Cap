import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe } from "@fortawesome/free-solid-svg-icons";
import { useReducer, useState, useEffect, useRef } from "react";
import { checkOrganizationDomain } from "@/actions/organization/check-domain";

import { toast } from "sonner";
import { useDashboardContext } from "../../../../Contexts";
import { updateDomain } from "@/actions/organization/update-domain";
import { useRouter } from "next/navigation";
import { StepConfig, DomainConfig, StepAction, StepState, StepStatus } from "./types";
import { VerifyStep } from "./VerifyStep";
import { DomainStep } from "./DomainStep";
import { Stepper } from "./Stepper";
import { faRefresh } from "@fortawesome/free-solid-svg-icons";
import { CheckCircle, XCircle } from "lucide-react";
import { SuccesStep } from "./SuccessStep";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";

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
  isVerified: boolean;
  setIsVerified: (value: boolean) => void;
}

const CustomDomainDialog = ({
  open,
  onClose,
  isVerified,
  setIsVerified,
}: CustomDomainDialogProps) => {
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [domain, setDomain] = useState(
    activeOrganization?.organization.customDomain || ""
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
      index === stepState.currentIndex ?
        // Mark success as completed when reached, others as current
        (config.id === 'success' ? StepStatus.COMPLETED : StepStatus.CURRENT) :
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
      //if theres a domain already, remove it
      if (activeOrganization?.organization.customDomain) {
        await removeOrganizationDomain(
          activeOrganization?.organization.id as string
        );
      }


      const data = await updateDomain(
        cleanedDomain,
        activeOrganization?.organization.id as string
      )

      toast.success("Domain settings updated");
      router.refresh();

      if (data) {
        setDomainConfig(data.status);
        setIsVerified(data.verified);
        handleNext();
      }

      setTimeout(() => {
        checkVerification(false);
      }, 1000);

      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update domain settings"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  useEffect(() => {
    //if current step is success, close dialog in 1.5 seconds
    if (stepState.currentIndex === 2) {
      setTimeout(() => {
        handleClose();
      }, 1500);
    } else if (isVerified) {
      handleNext();
    }
  }, [isVerified, stepState.currentIndex])


  console.log({
    domainConfig,
    domain
  })

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="p-0 w-[calc(100%-20px)] focus:outline-none focus:ring-0 max-w-[600px] rounded-xl border bg-gray-2 border-gray-4">
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
            />
          )}

          {/* Success Step */}
          {currentStep.id === 'success' && (
            <SuccesStep />
          )}
        </div>

        {currentStep.id !== 'success' && (
          <DialogFooter>

            {currentStep.id === "verify" && (
              <div className="flex justify-between items-center w-full">
                <div className="flex gap-3 items-center">
                  {isVerified ? (
                    <div className="flex gap-2 items-center px-3 h-10 bg-green-900 rounded-full">
                      <CheckCircle className="text-green-200 size-4" />
                      <p className="text-sm font-medium text-white">Domain verified</p>
                    </div>
                  ) : (
                    <div className="flex gap-2 items-center px-3 h-10 bg-red-900 rounded-full">
                      <XCircle className="text-red-200 size-4" />
                      <p className="text-sm font-medium text-white">Domain not verified</p>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 items-center">
                  <Button
                    type="button"
                    variant="gray"
                    size="sm"
                    onClick={() => checkVerification(false)}
                    disabled={verifying}
                    className="min-w-[100px]"
                  >
                    {verifying ? (
                      <FontAwesomeIcon className="mr-1 opacity-70 animate-spin size-3.5" icon={faRefresh} />
                    ) : (
                      <FontAwesomeIcon className="mr-1 opacity-70 size-3.5" icon={faRefresh} />
                    )}
                    Check Status
                  </Button>

                  {isVerified && (
                    <Button
                      onClick={handleNext}
                      size="sm"
                      variant="dark"
                      className="min-w-[80px]"
                    >
                      Next
                    </Button>
                  )}
                </div>
              </div>
            )}

            {currentStep.id === 'domain' && (
              <Button
                onClick={handleDomainSubmit}
                size="sm"
                spinner={loading}
                disabled={loading || !domain.trim()}
                variant="dark"
                className="min-w-[100px]"
              >
                Next
              </Button>
            )}
          </DialogFooter>
        )}

      </DialogContent>
    </Dialog>
  );
};


export default CustomDomainDialog;
