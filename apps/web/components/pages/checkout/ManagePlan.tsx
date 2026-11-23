"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { Check, Loader2, Minus, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getCapFridayOffer } from "@/actions/billing/cap-friday";
import {
	type AddSeatsResult,
	addSeats,
	type CurrentPlan,
	previewAddSeats,
	type SeatPreviewResult,
} from "@/actions/billing/current-plan";
import { trackEvent } from "@/app/utils/analytics";
import { useEnded } from "@/components/pages/blackfriday/Claim";
import { CODE } from "@/components/pages/blackfriday/content";
import { BTN_PRIMARY } from "@/components/pages/HomeTwo/theme";
import type {
	CapFridayQuote,
	CapFridayRedeemResult,
	CapFridayState,
} from "@/lib/checkout/cap-friday";
import { parsePromotionCode } from "@/lib/checkout/plans";
import { formatAmount } from "@/utils/currency";
import {
	CapFridayCard,
	type CapFridayView,
	capFridayHeading,
	capFridaySeatPrice,
} from "./CapFridayPlan";
import { PlanFeatures, PlanHeading } from "./CheckoutForm";
import { CARD, CheckoutShell } from "./CheckoutShell";

const MAX_SEATS = 500;
const PREVIEW_DELAY_MS = 400;

const formatDate = (seconds: number) =>
	new Date(seconds * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

const STEP_BTN =
	"grid size-9 shrink-0 place-items-center rounded-full bg-[#EDF1F6] text-[#111111] transition-colors duration-200 hover:bg-[#DCE4EC] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#EDF1F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]";

export function ManagePlan({
	plan,
	requestedSeats,
	capFriday = null,
}: {
	plan: CurrentPlan;
	requestedSeats: number;
	capFriday?: CapFridayState | null;
}) {
	if (plan.type === "setup") {
		return (
			<CheckoutShell
				title="You're on Cap Pro"
				subtitle="Your subscription is active. Set up your workspace to start adding your team."
				summary={
					<>
						<PlanHeading tag="Active" />
						<PlanFeatures />
					</>
				}
			>
				<div className={classNames(CARD, "flex flex-col gap-5")}>
					<div>
						<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
							Finish setting up your workspace
						</h2>
						<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
							Once your workspace exists you can add seats here or from your
							organization settings.
						</p>
					</div>
					<Link
						href="/dashboard/caps"
						className={classNames(BTN_PRIMARY, "w-full")}
					>
						Set up workspace
					</Link>
				</div>
			</CheckoutShell>
		);
	}

	if (plan.type === "unavailable") {
		return <PlanUnavailable />;
	}

	if (plan.type === "development") {
		return (
			<CheckoutShell
				title="Your Cap Pro plan"
				subtitle="This account was made Pro from the dev toolbar."
				summary={
					<>
						<PlanHeading tag="Dev toolbar" />
						<PlanFeatures />
					</>
				}
			>
				<div className={classNames(CARD, "flex flex-col gap-4")}>
					<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
						No Stripe subscription to manage
					</h2>
					<p className="text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
						"Promote to Pro" sets Pro locally without creating a subscription,
						so there are no seats to add. To try this page, choose "Demote from
						Pro" in the dev toolbar, then buy Cap Pro here with a Stripe test
						card.
					</p>
				</div>
			</CheckoutShell>
		);
	}

	if (plan.type === "external") {
		return (
			<CheckoutShell
				title="You're on Cap Pro"
				subtitle="Your account already has everything in Cap Pro."
				summary={
					<>
						<PlanHeading tag="Active" />
						<PlanFeatures />
					</>
				}
			>
				<div className={classNames(CARD, "flex flex-col gap-5")}>
					<div>
						<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
							Seats are managed elsewhere
						</h2>
						<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
							Your Pro access comes from an organization owner or a separate
							billing arrangement, so there's nothing to buy here. Ask the
							person who manages billing to add seats, or email hello@cap.so.
						</p>
					</div>
					<Link
						href="/dashboard/caps"
						className={classNames(BTN_PRIMARY, "w-full")}
					>
						Go to your dashboard
					</Link>
				</div>
			</CheckoutShell>
		);
	}

	return (
		<AddSeats
			details={plan.details}
			requestedSeats={requestedSeats}
			capFriday={capFriday}
		/>
	);
}

const CARD_SURFACE =
	"transition-[background-color,box-shadow,color] duration-700 ease-out";
const FRIDAY_CARD =
	"rounded-[22px] bg-[#141113] p-5 text-[#F5F1EA] shadow-[0_0_0_1px_rgba(245,241,234,0.08),0_24px_60px_-30px_rgba(255,77,141,0.45)] sm:p-8";

function setPromoParam(code: string | null) {
	const url = new URL(window.location.href);
	if (code) url.searchParams.set("promo", code);
	else url.searchParams.delete("promo");
	window.history.replaceState(window.history.state, "", url);
}

function AddSeats({
	details,
	requestedSeats,
	capFriday,
}: {
	details: Extract<CurrentPlan, { type: "managed" }>["details"];
	requestedSeats: number;
	capFriday: CapFridayState | null;
}) {
	const router = useRouter();
	const current = details.currentQuantity;
	const yearly = details.billingInterval === "year";
	const perSeatPerPeriod = yearly
		? details.pricePerSeat * 12
		: details.pricePerSeat;
	const pastDue = details.status === "past_due";

	const [seats, setSeats] = useState(() =>
		Math.min(MAX_SEATS, Math.max(current + 1, requestedSeats)),
	);
	const planVersion = `${details.billingInterval}:${details.currentPeriodEnd}`;
	const [quote, setQuote] = useState<{
		plan: string;
		preview: SeatPreviewResult;
	} | null>(null);
	const preview = quote?.plan === planVersion ? quote.preview : null;
	const [submitting, setSubmitting] = useState(false);
	const [result, setResult] = useState<AddSeatsResult | null>(null);
	const [friday, setFriday] = useState<CapFridayView | null>(capFriday);
	const [fridayResult, setFridayResult] =
		useState<CapFridayRedeemResult | null>(null);
	const dark = friday !== null && !result?.ok;
	const offerRequest = useRef(0);

	const applyCode = () => {
		const request = ++offerRequest.current;
		setFriday({ type: "loading" });
		setFridayResult(null);
		setPromoParam(CODE);
		getCapFridayOffer()
			.catch((): CapFridayState => ({ type: "unavailable", reason: "custom" }))
			.then((offer) => {
				if (offerRequest.current === request) setFriday(offer);
			});
	};

	const removeCode = () => {
		offerRequest.current++;
		setFriday(null);
		setFridayResult(null);
		setPromoParam(null);
	};

	const onFridayResult = (next: CapFridayRedeemResult | null) => {
		setFridayResult(next);
		if (next?.ok) router.refresh();
	};

	useEffect(() => {
		if (pastDue || seats <= current) return;
		let active = true;
		setQuote(null);
		const timer = setTimeout(() => {
			previewAddSeats(seats)
				.then((next) => {
					if (active) setQuote({ plan: planVersion, preview: next });
				})
				.catch(() => {
					if (active) {
						setQuote({
							plan: planVersion,
							preview: {
								ok: false,
								message: "Couldn't price the extra seats.",
							},
						});
					}
				});
		}, PREVIEW_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [seats, current, pastDue, planVersion]);

	const added = seats - current;
	const dueToday =
		preview?.ok === true
			? formatAmount(
					Math.max(0, preview.proratedAmount) / 100,
					preview.currency,
				)
			: null;
	const renewal =
		preview?.ok === true && preview.recurringAmount > 0
			? formatAmount(preview.recurringAmount / 100, preview.currency)
			: formatAmount(perSeatPerPeriod * seats, details.currency);

	const submit = async () => {
		if (submitting || pastDue || !preview?.ok) return;
		setSubmitting(true);
		trackEvent("checkout_seats_added", { from: current, to: seats });
		const next = await addSeats(seats).catch(
			(): AddSeatsResult => ({ ok: false, message: "Couldn't add the seats." }),
		);
		setResult(next);
		setSubmitting(false);
		if (next.ok) router.refresh();
	};

	const summary = (
		<>
			<PlanHeading
				tag={dark ? "Cap Friday" : pastDue ? "Payment due" : "Your plan"}
				dark={dark}
			/>
			{dark ? (
				<FridayPrice
					quote={friday?.type === "quote" ? friday.quote : null}
					fallback={perSeatPerPeriod}
					currency={details.currency}
					yearly={yearly}
				/>
			) : (
				<div className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
					<span className="whitespace-nowrap text-[46px] font-normal leading-none tracking-[-0.03em] tabular-nums">
						{formatAmount(perSeatPerPeriod, details.currency)}
					</span>
					<span className="text-[14px] text-[rgba(17,17,17,0.5)] transition-colors duration-700">
						per user, per {yearly ? "year" : "month"}
					</span>
				</div>
			)}
			<dl
				className={classNames(
					"mt-6 flex flex-col gap-2.5 border-t pt-5 text-[14px] transition-colors duration-700",
					dark ? "border-[rgba(245,241,234,0.1)]" : "border-[#E1E7EE]",
				)}
			>
				<SummaryRow
					label="Seats"
					value={`${current} ${current === 1 ? "seat" : "seats"}`}
					dark={dark}
				/>
				<SummaryRow
					label="Billing"
					value={yearly ? "Yearly" : "Monthly"}
					dark={dark}
				/>
				<SummaryRow
					label={details.cancelAtPeriodEnd ? "Ends on" : "Renews on"}
					value={formatDate(details.currentPeriodEnd)}
					dark={dark}
				/>
				<SummaryRow
					label={`Every ${yearly ? "year" : "month"}`}
					value={formatAmount(perSeatPerPeriod * current, details.currency)}
					dark={dark}
				/>
			</dl>
			<Link
				href="/dashboard/settings/organization"
				className={classNames(
					"mt-5 inline-flex text-[14px] underline underline-offset-[4px] transition-colors duration-700",
					dark
						? "text-[rgba(245,241,234,0.6)] decoration-[rgba(245,241,234,0.25)] hover:text-[#F5F1EA]"
						: "text-[rgba(17,17,17,0.6)] decoration-[rgba(17,17,17,0.25)] hover:text-[#111111] hover:decoration-[#111111]",
				)}
			>
				Manage billing and invoices
			</Link>
			<CodeEntry
				applied={friday !== null}
				onApply={applyCode}
				onRemove={removeCode}
			/>
			<PlanFeatures dark={dark} />
		</>
	);

	if (result?.ok) {
		return (
			<CheckoutShell
				title="Seats added"
				subtitle="Your team can start recording and sharing with Cap Pro right away."
				summary={summary}
			>
				<div className={classNames(CARD, "flex flex-col gap-6")}>
					<span className="grid size-11 place-items-center rounded-full bg-[#E1EFFE] text-[#3D77C2]">
						<Check className="size-5" strokeWidth={2.25} />
					</span>
					<div>
						<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
							You now have {result.quantity} seats
						</h2>
						<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
							Invite people from your organization settings and give them a Pro
							seat. Stripe emails the receipt for today's charge.
						</p>
					</div>
					<Link
						href="/dashboard/settings/organization"
						className={classNames(BTN_PRIMARY, "w-full")}
					>
						Invite your team
					</Link>
				</div>
			</CheckoutShell>
		);
	}

	const heading = friday
		? capFridayHeading(friday, fridayResult)
		: {
				title: "Add seats to Cap Pro",
				subtitle:
					"Bring more of your team onto Cap Pro. You only pay for what's left of this billing period.",
			};

	return (
		<CheckoutShell
			title={heading.title}
			subtitle={heading.subtitle}
			summary={summary}
			capFriday={dark}
		>
			<div
				className={classNames(
					dark ? FRIDAY_CARD : CARD,
					CARD_SURFACE,
					"flex flex-col",
				)}
			>
				{friday ? (
					<CapFridayCard
						key={friday.type}
						view={friday}
						result={fridayResult}
						onResult={onFridayResult}
						onExit={removeCode}
					/>
				) : (
					<>
						<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
							Add seats
						</h2>
						<p className="mt-2 text-[14px] leading-[1.5] text-[rgba(17,17,17,0.6)]">
							You have {current} {current === 1 ? "seat" : "seats"} today.
							Choose how many you need in total.
						</p>

						<div className="mt-7 flex items-center justify-between gap-4 rounded-[16px] bg-[#F3F6FA] px-4 py-4">
							<div>
								<p className="text-[15px] font-medium">Total seats</p>
								<p className="mt-0.5 text-[13px] text-[rgba(17,17,17,0.55)]">
									{added > 0
										? `${added} new ${added === 1 ? "seat" : "seats"}`
										: "No change yet"}
								</p>
							</div>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={() =>
										setSeats((value) => Math.max(current + 1, value - 1))
									}
									disabled={seats <= current + 1 || submitting}
									className={STEP_BTN}
									aria-label="Remove a seat"
								>
									<Minus className="size-4" strokeWidth={2} />
								</button>
								<span className="w-12 text-center text-[20px] font-medium tabular-nums">
									<NumberFlow value={seats} />
								</span>
								<button
									type="button"
									onClick={() =>
										setSeats((value) => Math.min(MAX_SEATS, value + 1))
									}
									disabled={seats >= MAX_SEATS || submitting}
									className={STEP_BTN}
									aria-label="Add a seat"
								>
									<Plus className="size-4" strokeWidth={2} />
								</button>
							</div>
						</div>

						{pastDue ? (
							<p
								role="alert"
								className="mt-6 rounded-[12px] border border-[rgba(180,50,46,0.2)] bg-[#FDF3F2] px-3.5 py-3 text-[14px] leading-[1.45] text-[#8F2724]"
							>
								Your last payment didn't go through. Update your card in billing
								settings, then come back to add seats.
							</p>
						) : (
							<dl className="mt-6 flex flex-col gap-2.5 text-[14px]">
								<SummaryRow
									label="Due today"
									value={
										dueToday ??
										(preview?.ok === false ? "Unavailable" : "Calculating...")
									}
									strong
								/>
								<SummaryRow
									label={`From ${formatDate(details.currentPeriodEnd)}`}
									value={`${renewal} per ${yearly ? "year" : "month"}`}
								/>
							</dl>
						)}

						{details.cancelAtPeriodEnd && !pastDue ? (
							<p className="mt-4 text-[13px] leading-[1.5] text-[rgba(17,17,17,0.55)]">
								Your plan is set to end on{" "}
								{formatDate(details.currentPeriodEnd)}. Adding seats keeps it
								renewing.
							</p>
						) : null}

						{preview?.ok === false || result?.ok === false ? (
							<p
								role="alert"
								className="mt-5 rounded-[12px] border border-[rgba(180,50,46,0.2)] bg-[#FDF3F2] px-3.5 py-3 text-[14px] leading-[1.45] text-[#8F2724]"
							>
								{result?.ok === false
									? result.message
									: preview?.ok === false
										? preview.message
										: null}
							</p>
						) : null}

						{pastDue ? (
							<Link
								href="/dashboard/settings/organization"
								className={classNames(BTN_PRIMARY, "mt-7 w-full")}
							>
								Update payment method
							</Link>
						) : (
							<button
								type="button"
								onClick={submit}
								disabled={submitting || !preview?.ok}
								className={classNames(
									BTN_PRIMARY,
									"mt-7 w-full gap-2 disabled:cursor-not-allowed disabled:opacity-60",
								)}
							>
								{submitting ? (
									<>
										<Loader2 className="size-4 animate-spin" strokeWidth={2} />
										Adding seats...
									</>
								) : dueToday ? (
									`Add ${added} ${added === 1 ? "seat" : "seats"} for ${dueToday}`
								) : (
									`Add ${added} ${added === 1 ? "seat" : "seats"}`
								)}
							</button>
						)}

						<p className="mt-4 text-[12.5px] leading-[1.55] text-[rgba(17,17,17,0.55)]">
							We charge the card on file for the prorated amount today. Need
							fewer seats?{" "}
							<Link
								href="/dashboard/settings/organization"
								className="underline underline-offset-2"
							>
								Change them in settings
							</Link>
							.
						</p>
					</>
				)}
			</div>
		</CheckoutShell>
	);
}

function SummaryRow({
	label,
	value,
	strong,
	dark,
}: {
	label: string;
	value: string;
	strong?: boolean;
	dark?: boolean;
}) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<dt
				className={classNames(
					"transition-colors duration-700",
					strong
						? dark
							? "font-medium text-[#F5F1EA]"
							: "font-medium text-[#111111]"
						: dark
							? "text-[rgba(245,241,234,0.6)]"
							: "text-[rgba(17,17,17,0.66)]",
				)}
			>
				{label}
			</dt>
			<dd
				className={classNames(
					"tabular-nums transition-colors duration-700",
					dark ? "text-[#F5F1EA]" : "text-[#111111]",
					strong ? "text-[16px] font-medium" : "",
				)}
			>
				{value}
			</dd>
		</div>
	);
}

function PlanUnavailable() {
	const router = useRouter();
	const [retrying, setRetrying] = useState(false);

	return (
		<CheckoutShell
			title="Your Cap Pro plan"
			subtitle="Your account is on Cap Pro."
			summary={
				<>
					<PlanHeading tag="Active" />
					<PlanFeatures />
				</>
			}
		>
			<div role="alert" className={classNames(CARD, "flex flex-col gap-5")}>
				<div>
					<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
						We couldn't load your plan
					</h2>
					<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
						Something went wrong reading your subscription, so we can't show
						seats or prices right now. Nothing has changed on your plan. Try
						again in a moment, or manage seats from your organization settings.
					</p>
				</div>
				<button
					type="button"
					disabled={retrying}
					onClick={() => {
						setRetrying(true);
						router.refresh();
						setTimeout(() => setRetrying(false), 1500);
					}}
					className={classNames(
						BTN_PRIMARY,
						"w-full disabled:cursor-not-allowed disabled:opacity-60",
					)}
				>
					{retrying ? "Trying again..." : "Try again"}
				</button>
				<Link
					href="/dashboard/settings/organization"
					className="self-center text-[14px] text-[rgba(17,17,17,0.6)] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:text-[#111111] hover:decoration-[#111111]"
				>
					Open billing settings
				</Link>
			</div>
		</CheckoutShell>
	);
}

// Cap Pro subscribers never see the payment form, so the Cap Friday code is
// entered here and opens the offer for their existing plan.
function CodeEntry({
	applied,
	onApply,
	onRemove,
}: {
	applied: boolean;
	onApply: () => void;
	onRemove: () => void;
}) {
	const ended = useEnded();
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [invalid, setInvalid] = useState(false);
	const form = useRef<HTMLFormElement>(null);

	if (ended) return null;

	if (applied) {
		return (
			<div className="mt-4 flex items-center gap-2">
				<span className="inline-flex items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#FFD68C,#FF4D8D_60%,#B0369F)] py-1 pl-2.5 pr-1 text-[12.5px] font-medium tracking-[0.02em] text-[#141012] shadow-[0_0_20px_rgba(255,77,141,0.45)]">
					<Check className="size-3.5" strokeWidth={2.5} />
					{CODE}
					<button
						type="button"
						onClick={onRemove}
						aria-label={`Remove ${CODE}`}
						className="grid size-5 place-items-center rounded-full transition-colors hover:bg-black/10"
					>
						<X className="size-3" strokeWidth={2.5} />
					</button>
				</span>
			</div>
		);
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="mt-3 flex text-[14px] text-[rgba(17,17,17,0.6)] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:text-[#111111] hover:decoration-[#111111]"
			>
				Have a code?
			</button>
		);
	}

	return (
		<form
			ref={form}
			className="mt-4 flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (parsePromotionCode(code) !== CODE) {
					setInvalid(true);
					if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
						return;
					}
					form.current?.animate(
						[
							{ transform: "translateX(0)" },
							{ transform: "translateX(-6px)" },
							{ transform: "translateX(5px)" },
							{ transform: "translateX(-3px)" },
							{ transform: "translateX(0)" },
						],
						{ duration: 320, easing: "ease-out" },
					);
					return;
				}
				trackEvent("cap_friday_code_entered", { location: "manage_plan" });
				setOpen(false);
				setCode("");
				onApply();
			}}
		>
			<div className="flex gap-2">
				<input
					value={code}
					onChange={(event) => {
						setCode(event.target.value);
						setInvalid(false);
					}}
					placeholder="Code"
					aria-label="Code"
					aria-invalid={invalid}
					autoCapitalize="characters"
					autoComplete="off"
					spellCheck={false}
					// biome-ignore lint/a11y/noAutofocus: opened by the user on purpose
					autoFocus
					className="h-10 min-w-0 flex-1 rounded-[10px] bg-white px-3 text-[14px] uppercase shadow-[inset_0_0_0_1px_rgba(17,17,17,0.14)] outline-none focus-visible:shadow-[inset_0_0_0_1.5px_#111111]"
				/>
				<button
					type="submit"
					className="h-10 rounded-[10px] bg-[#111111] px-4 text-[14px] text-white transition-opacity hover:opacity-85"
				>
					Apply
				</button>
			</div>
			{invalid ? (
				<p role="alert" className="text-[13px] text-[#B4322E]">
					That code doesn't work for your plan.
				</p>
			) : null}
		</form>
	);
}

function FridayPrice({
	quote,
	fallback,
	currency,
	yearly,
}: {
	quote: CapFridayQuote | null;
	fallback: number;
	currency: string;
	yearly: boolean;
}) {
	const price = quote ? capFridaySeatPrice(quote) : null;
	return (
		<div className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
			<span className="whitespace-nowrap text-[46px] font-normal leading-none tracking-[-0.03em] tabular-nums">
				<NumberFlow
					value={price ? price.discounted / 100 : fallback}
					format={{ style: "currency", currency: currency.toUpperCase() }}
					locales="en-US"
				/>
			</span>
			{price ? (
				<span className="animate-bf-rise text-[18px] tabular-nums text-[rgba(245,241,234,0.45)] line-through decoration-[#FF4D8D] decoration-2 motion-reduce:animate-none">
					{formatAmount(price.full / 100, currency)}
				</span>
			) : null}
			<span className="text-[14px] text-[rgba(245,241,234,0.5)]">
				{price
					? quote?.kind === "yearly"
						? "per user, for your next year"
						: "per user, for your first year"
					: `per user, per ${yearly ? "year" : "month"}`}
			</span>
		</div>
	);
}
