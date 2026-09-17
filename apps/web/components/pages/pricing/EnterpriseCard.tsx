"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { trackEvent } from "@/app/utils/analytics";
import { BTN_SECONDARY, MODE_THEME } from "@/components/pages/HomeTwo/theme";
import { PLAN_LINK, PlanCard, type PlanToggle } from "./PlanCard";

const theme = MODE_THEME.studio;

const BOOK_A_CALL_URL = "https://calendar.app.google/BrQRrAeCzVR8Fd136";

const ADD_ONS = [
	{
		label: "SAML SSO",
		detail: "Flat rate, unlimited users",
		price: "$199/mo",
	},
	{ label: "Signed BAA", detail: "Per organization", price: "$99/mo" },
];

const FEATURES = [
	"SOC 2 Type II compliant",
	"ISO 27001 compliant",
	"HIPAA compliant",
	"SCIM provisioning can be arranged",
	"Custom S3 & Google Drive storage",
	"Volume discounts available",
];

export const EnterpriseCard = ({ collapsed, onToggle }: PlanToggle) => {
	return (
		<PlanCard
			name="Enterprise"
			tag="Self-serve"
			theme={theme}
			summary="Cap Pro price + optional add-ons"
			collapsed={collapsed}
			onToggle={onToggle}
			blurb="Cap Pro for organizations with thousands of members, with optional extras when you need them."
			lede={
				<p className="text-[16px] leading-[1.4] tracking-[-0.01em] text-[#111111] lg:text-[17px]">
					Everything in Cap Pro, at the Cap Pro price.
					<span className="text-[rgba(17,17,17,0.55)]">
						{" "}
						Add SAML SSO for your whole organization, or a signed BAA, only if
						you need them.
					</span>
				</p>
			}
			controls={
				<>
					<p className="text-[13px] font-medium text-[#111111]">
						Optional add-ons
					</p>
					<dl className="divide-y divide-[#E1E7EE] rounded-[12px] bg-[#F8FAFC] px-4">
						{ADD_ONS.map((addOn) => (
							<div
								key={addOn.label}
								className="flex items-center justify-between py-2.5 text-[14px]"
							>
								<dt>
									<span className="block text-[#111111]">{addOn.label}</span>
									<span className="block text-[12.5px] text-[rgba(17,17,17,0.5)]">
										{addOn.detail}
									</span>
								</dt>
								<dd className="font-medium tabular-nums text-[#111111]">
									{addOn.price}
								</dd>
							</div>
						))}
					</dl>
					<p className="text-[13.5px] leading-[1.5] text-[rgba(17,17,17,0.5)]">
						Fully self-serve. Turn either one on from your dashboard whenever
						you need it, no enterprise contract required.
					</p>
				</>
			}
			cta={
				<Link
					href="/dashboard/settings/organization"
					onClick={() =>
						trackEvent("pricing_cta_clicked", {
							source_page: "pricing_cards",
							plan_name: "enterprise",
							cta_action: "manage_add_ons",
						})
					}
					className={classNames(BTN_SECONDARY, "w-full")}
				>
					Manage add-ons
				</Link>
			}
			ctaNote="No sales call, no minimum seats. Book a call if you want one."
			featuresTitle="Security and control at scale"
			features={FEATURES}
			footer={
				<a
					href={BOOK_A_CALL_URL}
					target="_blank"
					rel="noopener noreferrer"
					onClick={() =>
						trackEvent("pricing_cta_clicked", {
							source_page: "pricing_cards",
							plan_name: "enterprise",
							cta_action: "book_call",
						})
					}
					className={PLAN_LINK}
				>
					Book a call with the team
					<ArrowUpRight className="size-3.5" />
				</a>
			}
		/>
	);
};
