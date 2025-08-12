import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import { faGlobe, faRefresh } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { checkOrganizationDomain } from "@/actions/organization/check-domain";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { updateDomain } from "@/actions/organization/update-domain";
import type { ConfettiRef } from "@/app/(org)/dashboard/_components/Confetti";
import { Confetti } from "@/app/(org)/dashboard/_components/Confetti";
import { useDashboardContext } from "../../../../Contexts";
import DomainStep from "./DomainStep";
import { Stepper } from "./Stepper";

import SubscribeContent from "./SubscribeContent";
import SuccesStep from "./SuccessStep";
import {
	type DomainConfig,
	type StepAction,
	type StepConfig,
	type StepState,
	StepStatus,
} from "./types";
import VerifyStep from "./VerifyStep";

const STEP_CONFIGS: StepConfig[] = [
	{
		id: "domain",
		name: "Domain",
		description: "Enter your custom domain",
	},
	{
		id: "verify",
		name: "Verify",
		description: "Verify domain ownership",
	},
	{
		id: "success",
		name: "Success",
		description: "Domain setup complete",
	},
];

// Reducer
const stepReducer = (state: StepState, action: StepAction): StepState => {
	switch (action.type) {
		case "NEXT_STEP":
			return {
				...state,
				currentIndex: Math.min(state.currentIndex + 1, state.totalSteps - 1),
				errors: {},
			};

		case "PREV_STEP":
			return {
				...state,
				currentIndex: Math.max(state.currentIndex - 1, 0),
				errors: {},
			};

		case "GO_TO_STEP": {
			const targetIndex = action.payload;
			const canNavigate =
				targetIndex <= state.currentIndex || state.canNavigateBack;

			return canNavigate
				? {
						...state,
						currentIndex: Math.max(
							0,
							Math.min(targetIndex, state.totalSteps - 1),
						),
						errors: {},
					}
				: state;
		}

		case "SET_ERROR":
			return {
				...state,
				errors: {
					...state.errors,
					[action.payload.stepId]: action.payload.error,
				},
			};

		case "CLEAR_ERROR": {
			const newErrors = { ...state.errors };
			delete newErrors[action.payload];
			return {
				...state,
				errors: newErrors,
			};
		}

		case "RESET":
			return {
				...state,
				currentIndex: 0,
				errors: {},
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
	setShowUpgradeModal: (arg: boolean) => void;
}

const CustomDomainDialog = ({
	open,
	onClose,
	isVerified,
	setIsVerified,
	setShowUpgradeModal,
}: CustomDomainDialogProps) => {
	const { activeOrganization, isSubscribed } = useDashboardContext();
	const [domain, setDomain] = useState(
		activeOrganization?.organization.customDomain || "",
	);
	const [domainConfig, setDomainConfig] = useState<DomainConfig | null>(null);
	const router = useRouter();
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const confettiRef = useRef<ConfettiRef>(null);

	const pollInterval = useRef<NodeJS.Timeout>();

	// Mutation for updating domain
	const updateDomainMutation = useMutation({
		mutationFn: async ({
			domain,
			orgId,
		}: {
			domain: string;
			orgId: string;
		}) => {
			if (activeOrganization?.organization.customDomain) {
				await removeOrganizationDomain(orgId);
			}
			return await updateDomain(domain, orgId);
		},
		onSuccess: (data) => {
			handleNext();
			toast.success("Domain settings updated");
			router.refresh();
			if (data) {
				setIsVerified(data.verified);
			}
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update domain settings",
			);
		},
	});

	// Mutation for checking domain verification
	const checkDomainMutation = useMutation({
		mutationFn: async ({
			orgId,
			showToasts,
		}: {
			orgId: string;
			showToasts: boolean;
		}) => {
			return { data: await checkOrganizationDomain(orgId), showToasts };
		},
		onSuccess: ({ data, showToasts }) => {
			setIsVerified(data.verified);
			setDomainConfig(data.config);

			if (data.verified) {
				handleNext();
			}

			// Only show toasts if explicitly requested
			if (showToasts) {
				if (data.verified) {
					toast.success("Domain is verified!");
					if (pollInterval.current) {
						clearInterval(pollInterval.current);
						pollInterval.current = undefined;
					}
				} else {
					toast.error(
						"Domain is not verified. Please check your DNS settings.",
					);
				}
			}
		},
		onError: (error, { showToasts }) => {
			if (showToasts) {
				toast.error("Failed to check domain verification");
			}
		},
	});

	const [stepState, dispatch] = useReducer(stepReducer, {
		currentIndex: 0,
		totalSteps: STEP_CONFIGS.length,
		canNavigateBack: true,
		errors: {},
	});

	const steps = STEP_CONFIGS.map((config, index) => ({
		...config,
		status:
			index < stepState.currentIndex
				? StepStatus.COMPLETED
				: index === stepState.currentIndex
					? // Mark success as completed when reached, others as current
						config.id === "success"
						? StepStatus.COMPLETED
						: StepStatus.CURRENT
					: StepStatus.PENDING,
		hasError: !!stepState.errors[config.id],
	}));

	const currentStep = steps[stepState.currentIndex];
	const canGoNext = stepState.currentIndex < STEP_CONFIGS.length - 1;

	if (!currentStep) {
		return null;
	}

	// Step navigation handlers
	const handleNext = () => {
		if (canGoNext) {
			dispatch({ type: "NEXT_STEP" });
		}
	};

	const handleStepClick = (index: number) => {
		dispatch({ type: "GO_TO_STEP", payload: index });
	};

	const handleReset = () => {
		dispatch({ type: "RESET" });
		setDomain("");
	};

	// Step-specific handlers
	const handleDomainSubmit = async () => {
		if (!domain.trim()) {
			dispatch({
				type: "SET_ERROR",
				payload: { stepId: "domain", error: "Domain is required" },
			});
			return;
		}

		if (domain === activeOrganization?.organization.customDomain) {
			return handleNext();
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
					cleanedDomain,
				);

			return hasTLD ? cleanedDomain : "";
		};

		const cleanedDomain = cleanDomain(domain);
		if (!cleanedDomain) {
			dispatch({
				type: "SET_ERROR",
				payload: { stepId: "domain", error: "Please enter a valid domain" },
			});
			return;
		}

		dispatch({ type: "CLEAR_ERROR", payload: "domain" });
		setDomain(cleanedDomain);

		updateDomainMutation.mutate({
			domain: cleanedDomain,
			orgId: activeOrganization?.organization.id as string,
		});
	};

	const checkVerification = async (showToasts = true) => {
		if (
			!activeOrganization?.organization.id ||
			!activeOrganization?.organization.customDomain
		)
			return;

		checkDomainMutation.mutate({
			orgId: activeOrganization.organization.id,
			showToasts,
		});
	};

	const handleClose = () => {
		handleReset();
		onClose();
	};

	useEffect(() => {
		//if current step is success, close dialog in 8 seconds
		if (stepState.currentIndex === 2) {
			setTimeout(() => {
				handleClose();
			}, 8000);
		} else if (isVerified) {
			handleNext();
		}
	}, [isVerified, stepState.currentIndex]);

	return (
		<>
			{stepState.currentIndex === 2 && (
				<Confetti
					ref={confettiRef}
					className="absolute inset-0 w-full h-full z-[600] pointer-events-none"
					options={{
						particleCount: 150,
						spread: 120,
						origin: { x: 0.5, y: 0.5 },
					}}
				/>
			)}
			<Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
				<DialogContent
					ref={dialogRef}
					className="p-0 w-[calc(100%-20px)] focus:outline-none focus:ring-0 max-w-[600px] rounded-xl border bg-gray-2 border-gray-4"
				>
					<DialogHeader
						icon={<FontAwesomeIcon icon={faGlobe} />}
						description="Let's get you setup with your custom domain for your caps."
					>
						<DialogTitle className="text-lg text-gray-12">
							Custom Domain
						</DialogTitle>
					</DialogHeader>

					<Stepper steps={steps} onStepClick={handleStepClick} />

					<div className="relative w-full h-full">
						{!isSubscribed && <SubscribeContent />}

						<div className="p-5">
							{/* Domain Step */}
							{currentStep.id === "domain" && (
								<DomainStep
									domain={domain}
									setDomain={setDomain}
									submitLoading={updateDomainMutation.isPending}
									onSubmit={handleDomainSubmit}
									error={stepState.errors.domain}
									onClearError={() =>
										dispatch({ type: "CLEAR_ERROR", payload: "domain" })
									}
								/>
							)}

							{/* Verify Step */}
							{currentStep.id === "verify" && (
								<VerifyStep
									domain={domain}
									initialConfigLoading={
										checkDomainMutation.isPending && domainConfig === null
									}
									domainConfig={domainConfig}
									checkVerification={checkVerification}
									isVerified={isVerified}
								/>
							)}

							{/* Success Step */}
							{currentStep.id === "success" && <SuccesStep />}
						</div>
					</div>

					{currentStep.id !== "success" && (
						<DialogFooter>
							{currentStep.id === "verify" && (
								<Button
									type="button"
									variant="gray"
									size="sm"
									onClick={() => checkVerification(false)}
									disabled={checkDomainMutation.isPending}
									className="min-w-[100px]"
								>
									{checkDomainMutation.isPending ? (
										<FontAwesomeIcon
											className="mr-1 opacity-70 animate-spin size-3.5"
											icon={faRefresh}
										/>
									) : (
										<FontAwesomeIcon
											className="mr-1 opacity-70 size-3.5"
											icon={faRefresh}
										/>
									)}
									Check Status
								</Button>
							)}

							{currentStep.id === "domain" && (
								<>
									{isSubscribed ? (
										<Button
											onClick={handleDomainSubmit}
											size="sm"
											spinner={updateDomainMutation.isPending}
											disabled={
												updateDomainMutation.isPending || !domain.trim()
											}
											variant="dark"
											className="min-w-[100px]"
										>
											Next
										</Button>
									) : (
										<Button
											variant="blue"
											size="sm"
											onClick={() => {
												setShowUpgradeModal(true);
												handleClose();
											}}
										>
											Upgrade To Cap Pro
										</Button>
									)}
								</>
							)}
						</DialogFooter>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
};

export default CustomDomainDialog;
