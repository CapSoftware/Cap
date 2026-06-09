"use client";

import { Button } from "@cap/ui";
import { useRef } from "react";
import { EnterpriseArt, type EnterpriseArtRef } from "./EnterpriseArt";
import { PlanFeature } from "./PlanFeature";

const enterpriseFeatures = [
	"SLAs & priority support",
	"SAML SSO & SCIM provisioning",
	"Managed self-hosting",
	"Volume discounts",
	"Advanced security controls",
	"Dedicated onboarding",
];

export const EnterpriseCard = () => {
	const artRef = useRef<EnterpriseArtRef>(null);

	const handleBookCall = () => {
		window.open("https://cal.com/cap.so/15min", "_blank");
	};

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex flex-col p-8 rounded-2xl border bg-gray-1 border-gray-5"
		>
			<div className="mb-4 size-14 -ml-3">
				<EnterpriseArt ref={artRef} />
			</div>
			<h3 className="text-lg font-semibold text-gray-12">Enterprise</h3>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				For organizations that need security, control, and dedicated support at
				scale.
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight text-gray-12">
					Custom
				</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">tailored to your team</p>

			<div className="mt-6 min-h-[120px]">
				<div className="p-4 text-sm leading-relaxed rounded-lg border bg-gray-2 border-gray-4 text-gray-10">
					Custom annual billing with volume discounts, onboarding, and a
					dedicated success manager.
				</div>
			</div>

			<Button
				variant="outline"
				size="lg"
				onClick={handleBookCall}
				className="mt-6 w-full font-medium"
				aria-label="Talk to sales about Enterprise"
			>
				Talk to sales
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">
					Everything in Cap Pro, plus:
				</p>
				<ul className="space-y-3">
					{enterpriseFeatures.map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
			</div>
		</article>
	);
};
