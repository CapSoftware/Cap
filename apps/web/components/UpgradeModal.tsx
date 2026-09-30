"use client";

import { buildEnv } from "@cap/env";
import { Button, Dialog, DialogContent, Switch } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import { useCurrency } from "hooks/useCurrency";
import {
	BarChart3,
	Clock,
	Cloud,
	Database,
	Globe,
	Headphones,
	Infinity as InfinityIcon,
	Link2,
	Lock,
	Mic,
	Minus,
	Plus,
	Shield,
	ShieldCheck,
	Sparkles,
	Video,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { memo, useRef, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { PRICING } from "@/data/pricing";
import { Fit, Layout, useRive } from "@/lib/rive";

interface UpgradeModalProps {
	open: boolean;
	onboarding?: boolean;
	onOpenChange: (open: boolean) => void;
	onCheckout?: () => Promise<void>;
	dismissible?: boolean;
}

const modalVariants = {
	hidden: {
		opacity: 0,
		scale: 0.95,
		y: 10,
	},
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: {
			type: "spring" as const,
			duration: 0.4,
			damping: 25,
			stiffness: 500,
		},
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 10,
		transition: {
			duration: 0.2,
		},
	},
};

const ANNUAL_SAVINGS_PERCENT = Math.round(
	(1 - PRICING.pro.annualPerMonth / PRICING.pro.monthly) * 100,
);

const iconStyling = "text-blue-500 size-4";

const PRO_FEATURES = [
	{
		icon: <Link2 className={iconStyling} />,
		title: "Unlimited shareable links",
		description: "No monthly limit, every video is instantly shareable",
	},
	{
		icon: <Clock className={iconStyling} />,
		title: "Unlimited recording length",
		description: "The 5 minute free recording cap is removed",
	},
	{
		icon: <Cloud className={iconStyling} />,
		title: "Unlimited cloud storage",
		description: "Keep every recording, forever",
	},
	{
		icon: <Sparkles className={iconStyling} />,
		title: "Cap AI",
		description: "Automatic titles, summaries, chapters & more",
	},
	{
		icon: <Globe className={iconStyling} />,
		title: "Custom domain",
		description: "Share videos from your own domain",
	},
	{
		icon: <Lock className={iconStyling} />,
		title: "Password protected videos",
		description: "Control exactly who can watch",
	},
	{
		icon: <BarChart3 className={iconStyling} />,
		title: "Analytics",
		description: "Views, engagement and viewer insights",
	},
	{
		icon: <Video className={iconStyling} />,
		title: "Upload & import videos",
		description: "Upload existing files or import straight from Loom",
	},
	{
		icon: <Mic className={iconStyling} />,
		title: "Audio & video comments",
		description: "Viewers reply on the timeline with voice or camera",
	},
	{
		icon: <Database className={iconStyling} />,
		title: "Custom storage",
		description: "Connect your own Google Drive or S3 bucket",
	},
	{
		icon: <InfinityIcon className={iconStyling} />,
		title: "Unlimited views",
		description: "No limits on video views",
	},
	{
		icon: <Shield className={iconStyling} />,
		title: "Commercial license",
		description: "Desktop app commercial license included",
	},
	{
		icon: <ShieldCheck className={iconStyling} />,
		title: "SOC 2, ISO 27001 & HIPAA",
		description: "Independently audited security & compliance",
	},
	{
		icon: <Headphones className={iconStyling} />,
		title: "Priority support",
		description: "Get help when you need it",
	},
];

const UpgradeModalImpl = ({
	open,
	onOpenChange,
	onCheckout,
	onboarding,
	dismissible = true,
}: UpgradeModalProps) => {
	const stripeCtx = useStripeContext();
	const { currency } = useCurrency();
	const [isAnnual, setIsAnnual] = useState(false);
	const [proQuantity, setProQuantity] = useState(1);
	const upgradeButtonRef = useRef<HTMLButtonElement>(null);
	const { push } = useRouter();

	const pricePerUser = isAnnual ? PRICING.pro.yearlyTotal : PRICING.pro.monthly;
	const totalPrice = pricePerUser * proQuantity;
	const billingText = isAnnual ? "billed annually" : "billed monthly";

	const proCheckoutMutation = useMutation({
		mutationFn: async () => {
			const planId = stripeCtx.plans[isAnnual ? "yearly" : "monthly"];

			const response = await fetch(`/api/settings/billing/subscribe`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					priceId: planId,
					quantity: proQuantity,
					isOnBoarding: onboarding,
				}),
			});
			const data = await response.json();

			if (data.auth === false) {
				localStorage.setItem("pendingPriceId", planId);
				localStorage.setItem("pendingQuantity", proQuantity.toString());
				push(`/login?next=/dashboard`);
				return;
			}

			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
				onOpenChange(false);
			}

			await onCheckout?.();

			if (data.url) {
				window.location.href = data.url;
			}
		},
	});

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen || dismissible) {
			onOpenChange(nextOpen);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				onEscapeKeyDown={(event) => {
					if (!dismissible) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (!dismissible) event.preventDefault();
				}}
				// Land focus on the upgrade CTA so Space/Enter proceed natively
				// (Radix would otherwise focus the close button, where Space would
				// dismiss the dialog we just advertised a Space shortcut in).
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					upgradeButtonRef.current?.focus();
				}}
				onKeyDown={(event) => {
					if (event.code !== "Space") return;
					// Focused controls keep their native Space behavior (switch
					// toggle, stepper, close); the shortcut only fires from inert
					// targets so it never double-activates.
					const target = event.target as HTMLElement | null;
					if (
						target?.closest(
							"button, a, input, textarea, select, [role='switch'], [contenteditable]",
						)
					)
						return;
					event.preventDefault();
					if (!proCheckoutMutation.isPending) proCheckoutMutation.mutate();
				}}
				className={[
					"sm:max-w-[1100px] w-[calc(100%-20px)] custom-scroll bg-gray-2 border border-gray-4 overflow-y-auto max-h-[90vh] p-0",
					dismissible ? "" : "[&>button:last-child]:hidden",
				].join(" ")}
			>
				<AnimatePresence mode="wait">
					{open && (
						<motion.div
							className="flex relative flex-col h-full md:flex-row"
							variants={modalVariants}
							initial="hidden"
							animate="visible"
							exit="exit"
						>
							<div className="flex relative flex-col flex-1 justify-between items-end self-stretch border-r-0 border-b md:border-b-0 md:border-r border-gray-4">
								<div className="h-36 md:h-[275px] border-b border-gray-4 w-full overflow-hidden">
									<ProRiveArt />
								</div>
								<div className="flex relative flex-col flex-1 justify-center items-center px-4 py-6 w-full">
									<div className="flex flex-col items-center">
										<h1 className="text-2xl font-medium sm:text-3xl text-gray-12">
											Upgrade to Cap Pro
										</h1>
									</div>
									<p className="mt-1 text-base text-center sm:text-lg text-gray-11">
										You can cancel anytime.
									</p>

									<div className="flex flex-col items-center mt-3 mb-4 w-full">
										<div className="flex flex-col items-center mb-1 sm:items-end sm:flex-row">
											<NumberFlow
												value={totalPrice}
												className="text-3xl font-medium tabular-nums text-gray-12"
												format={{
													style: "currency",
													currency: currency.toUpperCase(),
												}}
											/>
											<span className="mb-2 ml-2 text-gray-11">
												{proQuantity === 1 ? (
													`per user, ${billingText}`
												) : (
													<>
														for{" "}
														<NumberFlow
															value={proQuantity}
															className="tabular-nums text-gray-12"
														/>{" "}
														users, {billingText}
													</>
												)}
											</span>
										</div>

										<div className="flex flex-col gap-6 justify-evenly items-center mt-6 w-full max-w-md sm:gap-8 sm:flex-row">
											<div className="flex gap-3 items-center">
												<span className="text-gray-12">Annual billing</span>
												<Switch
													checked={isAnnual}
													onCheckedChange={() => setIsAnnual(!isAnnual)}
												/>
												<span
													className={[
														"rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors",
														isAnnual
															? "bg-blue-500/10 text-blue-500"
															: "bg-gray-4 text-gray-10",
													].join(" ")}
												>
													Save {ANNUAL_SAVINGS_PERCENT}%
												</span>
											</div>

											<div className="flex items-center">
												<span className="mr-3 text-gray-12">Users:</span>
												<div className="flex items-center">
													<button
														type="button"
														onClick={() =>
															proQuantity > 1 && setProQuantity(proQuantity - 1)
														}
														className="flex justify-center items-center w-8 h-8 rounded-l-md bg-gray-4 hover:bg-gray-5"
														disabled={proQuantity <= 1}
													>
														<Minus className="w-4 h-4 text-gray-12" />
													</button>
													<NumberFlow
														value={proQuantity}
														className="mx-auto w-6 text-sm tabular-nums text-center text-gray-12"
													/>
													<button
														type="button"
														onClick={() => setProQuantity(proQuantity + 1)}
														className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5"
													>
														<Plus className="w-4 h-4 text-gray-12" />
													</button>
												</div>
											</div>
										</div>
									</div>

									<Button
										ref={upgradeButtonRef}
										variant="blue"
										type="button"
										aria-keyshortcuts="Space"
										onClick={(e) => {
											e.preventDefault();
											proCheckoutMutation.mutate();
										}}
										className="flex-col gap-1.5 mt-5 w-full max-w-sm h-16 text-base"
										disabled={proCheckoutMutation.isPending}
									>
										{proCheckoutMutation.isPending ? (
											"Loading..."
										) : (
											<>
												<span className="leading-none">Upgrade to Cap Pro</span>
												<span className="hidden gap-1 items-center sm:flex text-[10px] font-normal text-white/70">
													or,
													<kbd className="flex justify-center items-center px-1 rounded border bg-white/15 border-white/25 h-[14px] text-[9px] font-medium text-white/80">
														spacebar
													</kbd>
												</span>
											</>
										)}
									</Button>
									{dismissible && (
										<button
											type="button"
											className="mt-2 w-full max-w-sm h-10 text-base rounded-xl hover:underline text-gray-11 hover:text-gray-12"
											onClick={() => onOpenChange(false)}
										>
											Skip
										</button>
									)}
								</div>
							</div>

							<div className="flex flex-1 justify-center items-center self-stretch p-5 bg-transparent sm:p-6 md:p-8 md:bg-gray-3">
								<div className="grid grid-cols-1 gap-x-8 gap-y-4 w-full sm:grid-cols-2 md:gap-y-5">
									{PRO_FEATURES.map((feature) => (
										<div key={feature.title} className="flex gap-3 items-start">
											<div className="flex justify-center items-center rounded-lg bg-gray-5 shrink-0 size-8">
												{feature.icon}
											</div>
											<div className="min-w-0">
												<h3 className="text-sm font-medium text-gray-12">
													{feature.title}
												</h3>
												<p className="mt-0.5 text-xs leading-relaxed text-gray-11">
													{feature.description}
												</p>
											</div>
										</div>
									))}
								</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</DialogContent>
		</Dialog>
	);
};

export const UpgradeModal =
	buildEnv.NEXT_PUBLIC_IS_CAP !== "true" ? () => null : UpgradeModalImpl;

const ProRiveArt = memo(() => {
	const { RiveComponent: ProModal } = useRive({
		src: "/rive/main.riv",
		artboard: "cap-pro-modal",
		animations: ["animation"],
		layout: new Layout({
			fit: Fit.Cover,
		}),
		autoplay: true,
	});

	return <ProModal className="w-full h-full" />;
});
