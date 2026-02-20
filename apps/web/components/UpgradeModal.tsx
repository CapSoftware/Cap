"use client";

import { buildEnv } from "@cap/env";
import { Button, Dialog, DialogContent, Switch } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
	BarChart3,
	Database,
	Globe,
	Headphones,
	Infinity,
	Lock,
	Minus,
	Plus,
	Share2,
	Shield,
	Sparkles,
	Video,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";

interface UpgradeModalProps {
	open: boolean;
	onboarding?: boolean;
	onOpenChange: (open: boolean) => void;
	onCheckout?: () => Promise<void>;
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
			type: "spring",
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

const UpgradeModalImpl = ({
	open,
	onOpenChange,
	onCheckout,
	onboarding,
}: UpgradeModalProps) => {
	const stripeCtx = useStripeContext();
	const [isAnnual, setIsAnnual] = useState(true);
	const [proQuantity, setProQuantity] = useState(1);
	const { push } = useRouter();

	const pricePerUser = isAnnual ? 8.16 : 12;
	const totalPrice = pricePerUser * proQuantity;
	const billingText = isAnnual ? "billed annually" : "billed monthly";

	useRive({
		src: "/rive/main.riv",
		artboard: "cap-pro-modal",
		animations: ["animation"],
		layout: new Layout({
			fit: Fit.Cover,
		}),
		autoplay: true,
	});

	const iconStyling = "text-blue-500 size-[18px]";
	const proFeatures = [
		{
			icon: <Globe className={iconStyling} />,
			title: "Custom domain",
			description: "Connect your own domain to Cap",
		},
		{
			icon: <Share2 className={iconStyling} />,
			title: "Unlimited sharing",
			description: "Cloud storage & shareable links",
		},
		{
			icon: <Sparkles className={iconStyling} />,
			title: "Cap AI",
			description: "Automatic video chapters, summaries & more",
		},
		{
			icon: <Lock className={iconStyling} />,
			title: "Password protected videos",
			description: "Enhanced security for your content",
		},
		{
			icon: <Database className={iconStyling} />,
			title: "Custom storage",
			description: "Connect your own S3 bucket",
		},
		{
			icon: <Shield className={iconStyling} />,
			title: "Commercial license",
			description: "Commercial license for desktop app automatically included",
		},
		{
			icon: <Video className={iconStyling} />,
			title: "Upload videos",
			description: "Upload custom videos directly to Cap",
		},
		{
			icon: <Infinity className={iconStyling} />,
			title: "Unlimited views",
			description: "No limits on video views",
		},
		{
			icon: <BarChart3 className={iconStyling} />,
			title: "Analytics",
			description: "Video viewing insights",
		},
		{
			icon: <Headphones className={iconStyling} />,
			title: "Priority support",
			description: "Get help when you need it",
		},
	];

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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-[1100px] w-[calc(100%-20px)] custom-scroll bg-gray-2 border
      border-gray-4 overflow-y-auto md:overflow-hidden max-h-[90vh] p-0"
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
								<div className="h-[275px] border-b border-gray-4 w-full overflow-hidden">
									<ProRiveArt />
								</div>
								<div className="flex relative flex-col flex-1 justify-center items-center py-6 w-full">
									<div className="flex flex-col items-center">
										<h1 className="text-3xl font-medium text-gray-12">
											Upgrade to Cap Pro
										</h1>
									</div>
									<p className="mt-1 text-lg text-center text-gray-11">
										You can cancel anytime. Early adopter pricing locked in.
									</p>

									<div className="flex flex-col items-center mt-3 mb-4 w-full">
										<div className="flex flex-col items-center mb-1 sm:items-end sm:flex-row">
											<NumberFlow
												value={totalPrice}
												className="text-3xl font-medium tabular-nums text-gray-12"
												format={{
													style: "currency",
													currency: "USD",
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

										<div className="flex flex-col gap-6 justify-evenly items-center mt-8 w-full max-w-md sm:gap-10 sm:flex-row">
											<div className="flex gap-3 items-center">
												<span className="text-gray-12">Annual billing</span>
												<Switch
													checked={isAnnual}
													onCheckedChange={() => setIsAnnual(!isAnnual)}
												/>
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
										variant="blue"
										type="button"
										onClick={(e) => {
											e.preventDefault();
											proCheckoutMutation.mutate();
										}}
										className="mt-5 w-full max-w-sm h-14 text-lg"
										disabled={proCheckoutMutation.isPending}
									>
										{proCheckoutMutation.isPending
											? "Loading..."
											: "Upgrade to Cap Pro"}
									</Button>
									<button
										type="button"
										className="mt-2 w-full max-w-sm h-14 text-base rounded-xl hover:underline text-gray-11 hover:text-gray-12"
										onClick={() => onOpenChange(false)}
									>
										Skip
									</button>
								</div>
							</div>

							<div className="flex flex-1 justify-center items-center self-stretch p-8 bg-transparent md:bg-gray-3">
								<div className="grid grid-cols-1 gap-8 md:gap-4 md:grid-cols-2">
									{proFeatures.map((feature, index) => (
										<div
											key={index.toString()}
											className="flex flex-col justify-center items-center"
										>
											<div className="mb-3.5 bg-gray-5 rounded-full size-10 flex items-center justify-center">
												{feature.icon}
											</div>
											<h3 className="text-base font-medium text-center text-gray-12">
												{feature.title}
											</h3>
											<p className="text-sm text-center text-gray-11">
												{feature.description}
											</p>
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
