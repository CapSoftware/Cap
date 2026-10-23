"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { useCurrency } from "hooks/useCurrency";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { BTN_SECONDARY, MODE_THEME } from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";
import { Segmented, Stepper } from "./controls";
import { PLAN_LINK, PlanCard, type PlanToggle } from "./PlanCard";

const copy = homepageCopy.pricing.commercial;
const theme = MODE_THEME.screenshot;

export const DesktopLicenseCard = ({ collapsed, onToggle }: PlanToggle) => {
	const { symbol } = useCurrency();
	const [licenses, setLicenses] = useState(1);
	const [yearly, setYearly] = useState(true);
	const [loading, setLoading] = useState(false);

	const perLicense = yearly ? copy.pricing.yearly : copy.pricing.lifetime;
	const total = licenses * perLicense;

	const checkout = async () => {
		trackEvent("pricing_cta_clicked", {
			source_page: "pricing_cards",
			plan_name: "desktop",
			cta_action: "commercial_checkout",
			target_billing_period: yearly ? "yearly" : "lifetime",
			quantity: licenses,
		});
		setLoading(true);
		try {
			const response = await fetch("/api/commercial/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: yearly ? "yearly" : "lifetime",
					quantity: licenses,
				}),
			});
			const data = await response.json();
			if (response.ok && data.url) {
				window.location.href = data.url;
			} else {
				throw new Error(data.message);
			}
		} catch (error) {
			console.error("Error during commercial checkout:", error);
			toast.error("Failed to start checkout process");
		} finally {
			setLoading(false);
		}
	};

	return (
		<PlanCard
			name={copy.title}
			tag="Local only"
			theme={theme}
			summary={`${symbol}${copy.pricing.yearly} per license, per year`}
			collapsed={collapsed}
			onToggle={onToggle}
			blurb="A commercial license for the Cap desktop app. Unlimited local recording and editing, no cloud subscription required."
			price={
				<>
					{symbol}
					<NumberFlow value={perLicense} />
				</>
			}
			cadence={yearly ? "per license, per year" : "per license, one time"}
			note={
				yearly
					? `Or ${symbol}${copy.pricing.lifetime} once, for a license that never renews.`
					: `Or ${symbol}${copy.pricing.yearly} a year if you would rather pay as you go.`
			}
			controls={
				<>
					<Segmented
						ariaLabel="Billing option for Desktop License"
						value={yearly ? "yearly" : "lifetime"}
						onChange={(value) => setYearly(value === "yearly")}
						options={[
							{ value: "yearly", label: "Annual" },
							{ value: "lifetime", label: "Lifetime" },
						]}
						theme={theme}
					/>
					<Stepper
						label="Licenses"
						value={licenses}
						onIncrement={() => setLicenses((prev) => prev + 1)}
						onDecrement={() => setLicenses((prev) => Math.max(1, prev - 1))}
						decrementLabel="Decrease license count"
						incrementLabel="Increase license count"
					/>
					<p className="flex items-baseline justify-between text-[14px] text-[rgba(17,17,17,0.6)]">
						<span>Total</span>
						<span>
							<span className="font-medium tabular-nums text-[#111111]">
								{symbol}
								<NumberFlow value={total} />
							</span>{" "}
							{yearly ? "per year" : "one time"}
						</span>
					</p>
				</>
			}
			cta={
				<button
					type="button"
					onClick={checkout}
					disabled={loading}
					className={classNames(
						BTN_SECONDARY,
						"w-full disabled:cursor-not-allowed disabled:opacity-60",
					)}
				>
					{loading ? "Opening checkout..." : copy.cta}
				</button>
			}
			ctaNote="One user per license. Works fully offline."
			featuresTitle="What's included"
			features={copy.features}
			footer={
				<Link href="/docs/commercial-license" className={PLAN_LINK}>
					About the commercial license
					<ArrowUpRight className="size-3.5" />
				</Link>
			}
		/>
	);
};
