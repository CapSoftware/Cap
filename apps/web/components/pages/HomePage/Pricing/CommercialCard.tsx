"use client";

import { Button } from "@cap/ui";
import { faCircleInfo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/Tooltip";
import { WhenVisible } from "@/components/ui/WhenVisible";
import { homepageCopy } from "../../../../data/homepage-copy";
import { BillingToggle } from "./BillingToggle";
import { CommercialArt, type CommercialArtRef } from "./CommercialArt";
import { PlanFeature } from "./PlanFeature";
import { Stepper } from "./Stepper";

const copy = homepageCopy.pricing.commercial;

export const CommercialCard = () => {
	const [licenses, setLicenses] = useState(1);
	const [isYearly, setIsYearly] = useState(true);
	const [commercialLoading, setCommercialLoading] = useState(false);
	const artRef = useRef<CommercialArtRef>(null);

	const perLicense = isYearly ? copy.pricing.yearly : copy.pricing.lifetime;
	const total = licenses * perLicense;

	const incrementLicenses = () => setLicenses((prev) => prev + 1);
	const decrementLicenses = () =>
		setLicenses((prev) => (prev > 1 ? prev - 1 : 1));

	const openCommercialCheckout = async () => {
		setCommercialLoading(true);
		try {
			const response = await fetch(`/api/commercial/checkout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: isYearly ? "yearly" : "lifetime",
					quantity: licenses,
				}),
			});

			const data = await response.json();

			if (response.status === 200) {
				window.location.href = data.url;
			} else {
				throw new Error(data.message);
			}
		} catch (error) {
			console.error("Error during commercial checkout:", error);
			toast.error("Failed to start checkout process");
		} finally {
			setCommercialLoading(false);
		}
	};

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex flex-col p-8 rounded-2xl border bg-gray-1 border-gray-5"
		>
			<div className="mb-4 size-14 -ml-3">
				<WhenVisible className="size-full">
					<CommercialArt ref={artRef} />
				</WhenVisible>
			</div>
			<div className="flex gap-1.5 items-center">
				<h3 className="text-lg font-semibold text-gray-12">{copy.title}</h3>
				<TooltipPrimitive.Provider delayDuration={150}>
					<Tooltip
						position="top"
						className="max-w-[260px] items-start text-left leading-relaxed"
						content="A commercial license to use Cap on your desktop — unlimited local recording and editing, plus 20 cloud shareable links per month. No cloud subscription required."
					>
						<button
							type="button"
							aria-label="What's included in the Desktop License?"
							className="transition-colors text-gray-9 hover:text-gray-11"
						>
							<FontAwesomeIcon icon={faCircleInfo} className="size-3.5" />
						</button>
					</Tooltip>
				</TooltipPrimitive.Provider>
			</div>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				{copy.description}
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight tabular-nums text-gray-12">
					$<NumberFlow value={perLicense} />
				</span>
				<span className="text-sm text-gray-10">/ license</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">
				{isYearly ? "billed yearly" : "one-time payment"}
			</p>

			<div className="mt-6 space-y-3 min-h-[120px]">
				<BillingToggle
					ariaLabel="Billing option for Desktop License"
					value={isYearly ? "yearly" : "lifetime"}
					onChange={(value) => setIsYearly(value === "yearly")}
					options={[
						{ value: "yearly", label: "Annual" },
						{ value: "lifetime", label: "Lifetime" },
					]}
				/>
				<Stepper
					label="Licenses"
					value={licenses}
					onIncrement={incrementLicenses}
					onDecrement={decrementLicenses}
					decrementLabel="Decrease license count"
					incrementLabel="Increase license count"
				/>
				<p className="text-sm text-gray-10">
					<span className="font-medium text-gray-12">
						$<NumberFlow value={total} />
					</span>{" "}
					{isYearly ? "billed yearly" : "one-time"}
				</p>
			</div>

			<Button
				disabled={commercialLoading}
				onClick={openCommercialCheckout}
				variant="outline"
				size="lg"
				className="mt-6 w-full font-medium"
				aria-label="Purchase Commercial License"
			>
				{commercialLoading ? "Loading..." : copy.cta}
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">What's included</p>
				<ul className="space-y-3">
					{copy.features.map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
				<a
					href="/docs/commercial-license"
					className="inline-block mt-5 text-sm underline transition-colors text-gray-10 hover:text-gray-12"
				>
					Learn more about the commercial license
				</a>
			</div>
		</article>
	);
};
