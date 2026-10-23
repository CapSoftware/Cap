"use client";

import { Button } from "@cap/ui";
import { useRef } from "react";
import { WhenVisible } from "@/components/ui/WhenVisible";
import { EnterpriseArt, type EnterpriseArtRef } from "./EnterpriseArt";
import { PlanFeature } from "./PlanFeature";

const enterpriseFeatures = [
	"SOC 2 Type II compliant",
	"ISO 27001 compliant",
	"HIPAA compliant",
	"SCIM provisioning can be arranged",
	"Custom S3 & Google Drive storage",
	"Volume discounts available",
];

export const EnterpriseCard = () => {
	const artRef = useRef<EnterpriseArtRef>(null);

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex flex-col p-8 rounded-2xl border bg-gray-1 border-gray-5"
		>
			<div className="mb-4 size-14 -ml-3">
				<WhenVisible className="size-full">
					<EnterpriseArt ref={artRef} />
				</WhenVisible>
			</div>
			<h3 className="text-lg font-semibold text-gray-12">For enterprise</h3>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				Enterprise capabilities for organizations with thousands of members.
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight text-gray-12">
					Cap Pro
				</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">with optional add-ons</p>

			<div className="mt-6 space-y-3 min-h-[120px]">
				<dl className="space-y-2 text-sm">
					<div className="flex gap-3 justify-between">
						<dt className="text-gray-10">SAML SSO</dt>
						<dd className="font-medium text-gray-12">$199/mo</dd>
					</div>
					<div className="flex gap-3 justify-between">
						<dt className="text-gray-10">Signed BAA</dt>
						<dd className="font-medium text-gray-12">$99/mo</dd>
					</div>
				</dl>
				<p className="text-sm leading-relaxed text-gray-10">
					Fully self-serve. Add these anytime from your dashboard. No enterprise
					plan required.
				</p>
			</div>

			<Button
				href="/dashboard/settings/organization"
				variant="outline"
				size="lg"
				className="mt-6 w-full font-medium"
			>
				Manage add-ons
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">
					Security and control at scale:
				</p>
				<ul className="space-y-3">
					{enterpriseFeatures.map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
				<a
					href="https://calendar.app.google/BrQRrAeCzVR8Fd136"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-block mt-6 text-sm font-medium underline underline-offset-4 text-gray-12"
				>
					Need a hand? Book a call
				</a>
			</div>
		</article>
	);
};
