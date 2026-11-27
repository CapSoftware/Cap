"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { useCurrency } from "hooks/useCurrency";
import { ArrowUpRight, Gift, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { useEnded } from "@/components/pages/blackfriday/Claim";
import { CODE } from "@/components/pages/blackfriday/content";
import { BTN_SECONDARY, MODE_THEME } from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";
import { parsePromotionCode } from "@/lib/checkout/plans";
import { Segmented, Stepper } from "./controls";
import { PLAN_LINK, PlanCard, type PlanToggle } from "./PlanCard";

const copy = homepageCopy.pricing.commercial;
const theme = MODE_THEME.screenshot;

const amountText = (value: number) =>
	Number.isInteger(value) ? `${value}` : value.toFixed(2);

const amountFormat = (value: number) => {
	const digits = Number.isInteger(value) ? 0 : 2;
	return { minimumFractionDigits: digits, maximumFractionDigits: digits };
};

export const DesktopLicenseCard = ({ collapsed, onToggle }: PlanToggle) => {
	const { symbol } = useCurrency();
	const [licenses, setLicenses] = useState(1);
	const [yearly, setYearly] = useState(true);
	const [gift, setGift] = useState(false);
	const [loading, setLoading] = useState(false);
	const [codeApplied, setCodeApplied] = useState(false);
	const [enteringCode, setEnteringCode] = useState(false);
	const [codeDraft, setCodeDraft] = useState("");
	const codeInput = useRef<HTMLInputElement>(null);
	const offerEnded = useEnded();
	const offer = codeApplied && !offerEnded;

	useEffect(() => {
		const promo = new URLSearchParams(window.location.search).get("promo");
		if (parsePromotionCode(promo) === CODE) setCodeApplied(true);
	}, []);

	useEffect(() => {
		if (enteringCode) codeInput.current?.focus();
	}, [enteringCode]);

	const listPrice = yearly ? copy.pricing.yearly : copy.pricing.lifetime;
	const perLicense = offer ? listPrice / 2 : listPrice;
	const total = licenses * perLicense;

	const applyCode = (event: FormEvent) => {
		event.preventDefault();
		if (!codeDraft.trim()) {
			setEnteringCode(false);
			return;
		}
		if (parsePromotionCode(codeDraft) !== CODE) {
			toast.error("Enter that code on the checkout page.");
			return;
		}
		setCodeApplied(true);
		setEnteringCode(false);
		setCodeDraft("");
	};

	const checkout = async () => {
		trackEvent("pricing_cta_clicked", {
			source_page: "pricing_cards",
			plan_name: "desktop",
			cta_action: "commercial_checkout",
			target_billing_period: yearly ? "yearly" : "lifetime",
			quantity: licenses,
			gift,
			...(offer ? { promo_code: CODE } : {}),
		});
		setLoading(true);
		try {
			const response = await fetch("/api/commercial/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: yearly ? "yearly" : "lifetime",
					quantity: licenses,
					...(gift ? { gift: true } : {}),
					...(offer ? { promo: CODE } : {}),
				}),
			});
			const data = await response.json();
			if (response.ok && data.url && offer && data.discounted !== true) {
				setCodeApplied(false);
				toast.error(
					`${CODE} couldn't be applied. You can still check out at the regular price.`,
				);
				return;
			}
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
			summary={`${symbol}${amountText(offer ? copy.pricing.yearly / 2 : copy.pricing.yearly)} per license, per year`}
			collapsed={collapsed}
			onToggle={onToggle}
			blurb="A commercial license for the Cap desktop app. Unlimited local recording and editing, no cloud subscription required."
			price={
				<>
					{symbol}
					<NumberFlow value={perLicense} format={amountFormat(perLicense)} />
				</>
			}
			cadence={yearly ? "per license, per year" : "per license, one time"}
			note={
				offer
					? `50% off with ${CODE}, was ${symbol}${listPrice}.`
					: yearly
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
					{enteringCode && !offerEnded ? (
						<form
							onSubmit={applyCode}
							className="-my-1 flex items-center gap-1.5"
						>
							<input
								ref={codeInput}
								value={codeDraft}
								onChange={(event) => setCodeDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") setEnteringCode(false);
								}}
								aria-label="Promo code"
								placeholder="Promo code"
								autoCapitalize="characters"
								autoComplete="off"
								spellCheck={false}
								maxLength={40}
								className="h-8 min-w-0 flex-1 rounded-full border border-[#DDE4EB] bg-white px-3 text-[13px] uppercase text-[#111111] placeholder:normal-case placeholder:text-[rgba(17,17,17,0.4)] focus-visible:border-[#111111] focus-visible:outline-none"
							/>
							<button
								type="submit"
								className="h-8 shrink-0 rounded-full bg-[#EDF1F6] px-3 text-[13px] font-medium text-[#111111] transition-colors duration-200 hover:bg-[#DCE4EC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
							>
								Apply
							</button>
						</form>
					) : (
						<div className="flex h-6 items-center justify-between gap-x-2 whitespace-nowrap text-[14px] text-[rgba(17,17,17,0.6)]">
							<span className="flex items-center gap-2">
								Total
								{offer ? (
									<span
										className="flex items-center gap-1 rounded-full py-[3px] pl-2 pr-1 text-[12px] font-medium leading-none"
										style={{ background: theme.chip, color: theme.glyph }}
									>
										50% off
										<button
											type="button"
											onClick={() => setCodeApplied(false)}
											aria-label={`Remove ${CODE}`}
											className="grid size-4 place-items-center rounded-full transition-colors duration-200 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
										>
											<X className="size-3" strokeWidth={2.25} />
										</button>
									</span>
								) : offerEnded ? null : (
									<button
										type="button"
										onClick={() => setEnteringCode(true)}
										className="text-[13px] text-[rgba(17,17,17,0.5)] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[3px] transition-colors duration-200 hover:text-[#111111] hover:decoration-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
									>
										Add code
									</button>
								)}
							</span>
							<span>
								<span className="font-medium tabular-nums text-[#111111]">
									{symbol}
									<NumberFlow value={total} format={amountFormat(total)} />
								</span>{" "}
								{yearly ? "per year" : "one time"}
							</span>
						</div>
					)}
				</>
			}
			cta={
				<div className="flex gap-2">
					<button
						type="button"
						onClick={checkout}
						disabled={loading}
						className={classNames(
							BTN_SECONDARY,
							"min-w-0 flex-1 px-4 disabled:cursor-not-allowed disabled:opacity-60",
						)}
					>
						{loading
							? "Opening checkout..."
							: gift
								? "Gift Desktop License"
								: copy.cta}
					</button>
					<button
						type="button"
						onClick={() => setGift((on) => !on)}
						aria-pressed={gift}
						aria-label="Send as a gift"
						title="Send as a gift"
						className="grid size-[48px] shrink-0 place-items-center rounded-[10px] border border-[#D3DCE6] bg-white text-[#111111] transition-colors duration-200 hover:bg-[#EDF1F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
						style={
							gift
								? {
										background: theme.chip,
										borderColor: theme.accent,
										color: theme.glyph,
									}
								: undefined
						}
					>
						<Gift className="size-[18px]" strokeWidth={1.75} />
					</button>
				</div>
			}
			ctaNote={
				gift
					? "They claim it with a link you send."
					: "One user per license. Works fully offline."
			}
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
