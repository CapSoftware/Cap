"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { claimCapFriday } from "@/actions/billing/cap-friday";
import { trackEvent } from "@/app/utils/analytics";
import { Arrow, Sheen } from "@/components/pages/blackfriday/Claim";
import { Countdown } from "@/components/pages/blackfriday/Countdown";
import { CLAIM, DIM, GHOST } from "@/components/pages/blackfriday/theme";
import type {
	CapFridayQuote,
	CapFridayRedeemResult,
	CapFridayState,
} from "@/lib/checkout/cap-friday";
import { formatAmount } from "@/utils/currency";

export type CapFridayView = CapFridayState | { type: "loading" };

const BILLING = "/dashboard/settings/organization";
const MAIL =
	"mailto:hello@cap.so?subject=Cap%20Friday%3A%20lock%20in%20another%20year";

const day = (seconds: number) =>
	new Date(seconds * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

const money = (cents: number, currency: string) =>
	formatAmount(cents / 100, currency);

const brandName = (brand: string) =>
	({
		amex: "Amex",
		visa: "Visa",
		mastercard: "Mastercard",
		discover: "Discover",
		jcb: "JCB",
		diners: "Diners Club",
		unionpay: "UnionPay",
	})[brand] ?? "Card";

const rise = (delay: number) => ({ animationDelay: `${delay}s` });
const RISE = "animate-bf-rise motion-reduce:animate-none";

const UNAVAILABLE: Record<
	Extract<CapFridayState, { type: "unavailable" }>["reason"],
	{ title: string; body: string; action: { href: string; label: string } }
> = {
	ended: {
		title: "Cap Friday has ended",
		body: "Thanks for looking. Your plan carries on as normal.",
		action: { href: "/dashboard/caps", label: "Go to your dashboard" },
	},
	not_owner: {
		title: "Ask your billing owner",
		body: "Your Cap Pro seat is billed to someone else, so they can lock in the next year from their account.",
		action: { href: "/dashboard/caps", label: "Go to your dashboard" },
	},
	canceling: {
		title: "Your plan is set to end",
		body: "Turn renewal back on in billing settings, then come back here to lock in your next year.",
		action: { href: BILLING, label: "Open billing settings" },
	},
	past_due: {
		title: "Update your card first",
		body: "Your last payment didn't go through. Update your card, then come back to lock in your next year.",
		action: { href: BILLING, label: "Update payment method" },
	},
	no_card: {
		title: "Add a card first",
		body: "There's no card saved on your plan. Add one in billing settings, then come back here.",
		action: { href: BILLING, label: "Open billing settings" },
	},
	custom: {
		title: "We'll set this up for you",
		body: "Your plan has custom billing, so we'll lock in your next year by hand. Email us before the offer ends and we'll sort it.",
		action: { href: MAIL, label: "Email hello@cap.so" },
	},
};

export function capFridayHeading(
	view: CapFridayView,
	result: CapFridayRedeemResult | null,
): { title: string; subtitle: string } {
	const done = result?.ok ? result : null;
	if (done || view.type === "redeemed") {
		const kind =
			done?.kind ?? (view.type === "redeemed" ? view.kind : "prepay");
		const renewsOn =
			done?.renewsOn ?? (view.type === "redeemed" ? view.renewsOn : null);
		const date = renewsOn ? day(renewsOn) : null;
		return {
			title: "Locked in",
			subtitle:
				kind === "prepay"
					? date
						? `Your renewal on ${date} is paid for.`
						: "Your next renewal is paid for."
					: date
						? `You're on Cap Pro yearly. Your next renewal is ${date} at the normal price.`
						: "You're on Cap Pro yearly.",
		};
	}
	if (view.type === "awaiting_payment") {
		return {
			title: "Finish your payment",
			subtitle:
				"Your bank needs you to confirm the Cap Friday payment. Nothing changes until it's paid.",
		};
	}
	if (view.type === "unavailable") {
		const copy = UNAVAILABLE[view.reason];
		return { title: copy.title, subtitle: copy.body };
	}
	if (view.type === "quote" && view.quote.kind === "monthly") {
		return {
			title: "Switch to yearly at half price",
			subtitle:
				"Move to Cap Pro yearly today with the first year 50% off. We credit what's left of this month.",
		};
	}
	return {
		title: "Lock in your next year at half price",
		subtitle:
			"Pay for your next year of Cap Pro now and it's covered the day it renews.",
	};
}

export function CapFridayCard({
	view,
	result,
	onResult,
	onExit,
}: {
	view: CapFridayView;
	result: CapFridayRedeemResult | null;
	onResult: (result: CapFridayRedeemResult | null) => void;
	onExit: () => void;
}) {
	const [paying, setPaying] = useState(false);

	if (result?.ok || view.type === "redeemed") {
		return <Done />;
	}

	if (view.type === "loading") {
		return (
			<div aria-busy="true" className="flex flex-col gap-4">
				<span className="sr-only">Checking your plan</span>
				<div className="flex items-center justify-between">
					<div className="h-4 w-20 animate-pulse rounded-[6px] bg-[rgba(245,241,234,0.08)]" />
					<div className="h-10 w-32 animate-pulse rounded-[8px] bg-[rgba(245,241,234,0.08)]" />
				</div>
				<div className="mt-4 h-4 w-full animate-pulse rounded-[6px] bg-[rgba(245,241,234,0.06)]" />
				<div className="h-4 w-4/5 animate-pulse rounded-[6px] bg-[rgba(245,241,234,0.06)]" />
				<div className="h-4 w-3/5 animate-pulse rounded-[6px] bg-[rgba(245,241,234,0.06)]" />
				<div className="mt-4 h-14 w-full animate-pulse rounded-full bg-[rgba(245,241,234,0.08)]" />
			</div>
		);
	}

	if (view.type === "awaiting_payment") {
		return (
			<Message
				body="Confirm the payment with your bank on Stripe's secure page."
				action={{ href: view.payUrl, label: "Confirm payment" }}
				onExit={onExit}
			/>
		);
	}

	if (view.type === "unavailable") {
		const copy = UNAVAILABLE[view.reason];
		return <Message body={copy.body} action={copy.action} onExit={onExit} />;
	}

	const { quote } = view;
	const payUrl =
		result && !result.ok && "payUrl" in result ? result.payUrl : null;
	const error =
		result && !result.ok && "message" in result ? result.message : null;

	const pay = async () => {
		if (paying) return;
		setPaying(true);
		onResult(null);
		trackEvent("cap_friday_existing_claimed", {
			plan: quote.kind,
			quantity: quote.seats,
			currency: quote.currency,
		});
		const next = await claimCapFriday({
			dueToday: quote.dueToday,
			prorationDate: quote.kind === "monthly" ? quote.prorationDate : undefined,
		}).catch(
			(): CapFridayRedeemResult => ({
				ok: false,
				message:
					"Something went wrong. Refresh to see where your plan stands, or email hello@cap.so.",
			}),
		);
		setPaying(false);
		onResult(next);
	};

	return (
		<div className="flex flex-col text-left">
			<div
				className={classNames(
					"flex items-baseline justify-between gap-4",
					RISE,
				)}
			>
				<span className={`text-[15px] ${DIM}`}>Due today</span>
				<DueToday cents={quote.dueToday} currency={quote.currency} />
			</div>
			<p
				className={classNames(`mt-1 text-right text-[13px] ${DIM}`, RISE)}
				style={rise(0.05)}
			>
				{brandName(quote.card.brand)} ending {quote.card.last4}
			</p>

			<Breakdown quote={quote} />

			<Timeline steps={steps(quote)} />

			{error ? (
				<p
					role="alert"
					className="mt-6 rounded-[12px] bg-[rgba(255,77,141,0.1)] px-4 py-3 text-[14px] leading-[1.45] text-[#FFC2D6] shadow-[inset_0_0_0_1px_rgba(255,77,141,0.3)]"
				>
					{error}
				</p>
			) : null}

			{payUrl ? (
				<div className="mt-7 flex flex-col gap-3">
					<p className="text-[14px] leading-[1.5] text-[rgba(245,241,234,0.8)]">
						Your bank needs you to confirm this payment. Nothing changes until
						it's paid.
					</p>
					<a href={payUrl} className={classNames(CLAIM, "w-full")}>
						<Sheen />
						Confirm payment
						<Arrow />
					</a>
				</div>
			) : (
				<button
					type="button"
					onClick={pay}
					aria-busy={paying}
					disabled={paying}
					className={classNames(CLAIM, "mt-8 w-full", RISE)}
					style={rise(0.5)}
				>
					<Sheen />
					{paying ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="size-4 animate-spin" strokeWidth={2} />
							Paying...
						</span>
					) : (
						`Pay ${money(quote.dueToday, quote.currency)} now`
					)}
					<Arrow />
				</button>
			)}

			<p
				className={classNames(
					`mt-4 text-center text-[13px] leading-[1.5] ${DIM}`,
					RISE,
				)}
				style={rise(0.55)}
			>
				Stripe emails your receipt. <Countdown />.
			</p>
			<button
				type="button"
				onClick={onExit}
				className={`mx-auto mt-3 text-[13px] underline decoration-[rgba(245,241,234,0.25)] underline-offset-[4px] transition-colors hover:text-[#F5F1EA] ${DIM}`}
			>
				Remove code
			</button>
		</div>
	);
}

type Step = { when: string; body: ReactNode };

function steps(quote: CapFridayQuote): Step[] {
	const card = `${brandName(quote.card.brand)} ending ${quote.card.last4}`;
	const seats = `${quote.seats} ${quote.seats === 1 ? "seat" : "seats"}`;
	if (quote.kind === "yearly") {
		return [
			{
				when: "Today",
				body: (
					<>
						<strong>{money(quote.dueToday, quote.currency)}</strong> charged to
						your {card}. It's held as credit on your account.
					</>
				),
			},
			{
				when: day(quote.renewsOn),
				body: (
					<>
						Your yearly renewal ({money(quote.renewalAmount, quote.currency)},{" "}
						{seats}) is paid from that credit. <strong>You pay nothing.</strong>
					</>
				),
			},
			{
				when: day(quote.thenRenewsOn),
				body: (
					<>
						Cap Pro renews as normal at{" "}
						{money(quote.renewalAmount, quote.currency)} a year. Cancel any time
						before then.
					</>
				),
			},
		];
	}
	return [
		{
			when: "Today",
			body: (
				<>
					You move to Cap Pro yearly, {seats}.{" "}
					<strong>{money(quote.dueToday, quote.currency)}</strong> charged to
					your {card}. No more monthly charges.
				</>
			),
		},
		{
			when: day(quote.renewsOn),
			body: (
				<>
					Cap Pro renews at {money(quote.yearlyAmount, quote.currency)} a year.
					Cancel any time before then.
				</>
			),
		},
	];
}

export function capFridaySeatPrice(quote: CapFridayQuote) {
	const full =
		quote.kind === "yearly" ? quote.renewalAmount : quote.yearlyAmount;
	const discount =
		quote.kind === "yearly"
			? quote.renewalAmount - quote.dueToday
			: quote.discount;
	return {
		full: full / quote.seats,
		discounted: (full - discount) / quote.seats,
		discount,
		total: full,
	};
}

function Breakdown({ quote }: { quote: CapFridayQuote }) {
	const seats = `${quote.seats} ${quote.seats === 1 ? "seat" : "seats"}`;
	const { discount, total } = capFridaySeatPrice(quote);
	return (
		<dl
			className={classNames(
				"mt-6 flex flex-col gap-2 border-t border-[rgba(245,241,234,0.1)] pt-5 text-[14px]",
				RISE,
			)}
			style={rise(0.1)}
		>
			<Row
				label={
					quote.kind === "yearly"
						? `Your next year of Cap Pro, ${seats}`
						: `Cap Pro yearly, ${seats}`
				}
				value={money(total, quote.currency)}
			/>
			<Row
				label="Cap Friday, 50% off"
				value={`-${money(discount, quote.currency)}`}
				accent
			/>
			{quote.kind === "monthly" && quote.unusedCredit > 0 ? (
				<Row
					label="Unused time this month"
					value={`-${money(quote.unusedCredit, quote.currency)}`}
				/>
			) : null}
		</dl>
	);
}

function Row({
	label,
	value,
	accent,
}: {
	label: string;
	value: string;
	accent?: boolean;
}) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<dt className={DIM}>{label}</dt>
			<dd
				className={classNames(
					"tabular-nums",
					accent ? "text-[#FF8FB5]" : "text-[rgba(245,241,234,0.88)]",
				)}
			>
				{value}
			</dd>
		</div>
	);
}

function Timeline({ steps }: { steps: Step[] }) {
	return (
		<ol className="relative mt-7 flex flex-col gap-6 border-t border-[rgba(245,241,234,0.1)] pt-7">
			<span
				aria-hidden="true"
				className="absolute bottom-3 left-[7px] top-9 w-px origin-top animate-bf-line bg-[linear-gradient(180deg,#FFD68C,#FF4D8D_60%,rgba(176,54,159,0.2))] motion-reduce:animate-none"
				style={rise(0.2)}
			/>
			{steps.map((step, index) => (
				<li
					key={step.when}
					className={classNames(
						"relative grid grid-cols-[15px_1fr] gap-4",
						RISE,
					)}
					style={rise(0.25 + index * 0.12)}
				>
					<span
						aria-hidden="true"
						className="relative mt-1 grid size-[15px] animate-bf-pop place-items-center rounded-full bg-[#141113] shadow-[inset_0_0_0_1.5px_#FF7A9C,0_0_14px_rgba(255,77,141,0.55)] motion-reduce:animate-none"
						style={rise(0.3 + index * 0.12)}
					>
						<span className="size-[5px] rounded-full bg-[#FFD68C]" />
					</span>
					<div>
						<p className="text-[13px] font-medium tracking-[-0.01em] text-[#FFB59A]">
							{step.when}
						</p>
						<p className="mt-1 text-[15px] leading-[1.55] text-[rgba(245,241,234,0.82)] [&_strong]:font-medium [&_strong]:text-[#F5F1EA]">
							{step.body}
						</p>
					</div>
				</li>
			))}
		</ol>
	);
}

function DueToday({ cents, currency }: { cents: number; currency: string }) {
	const [value, setValue] = useState(0);
	useEffect(() => {
		const timer = window.setTimeout(() => setValue(cents / 100), 150);
		return () => window.clearTimeout(timer);
	}, [cents]);
	return (
		<span className="text-[40px] font-medium leading-none tracking-[-0.03em] tabular-nums text-[#F5F1EA]">
			<NumberFlow
				value={value}
				format={{ style: "currency", currency: currency.toUpperCase() }}
				locales="en-US"
				aria-label={money(cents, currency)}
			/>
		</span>
	);
}

function Done() {
	return (
		<div className="flex flex-col items-center py-4 text-center">
			<div className="relative grid place-items-center">
				<span
					aria-hidden="true"
					className="absolute size-20 animate-bf-ring rounded-full shadow-[0_0_0_2px_#FF4D8D,0_0_40px_rgba(255,77,141,0.6)] motion-reduce:hidden"
				/>
				<span
					aria-hidden="true"
					className="absolute size-20 animate-bf-ring rounded-full shadow-[0_0_0_2px_#FFD68C] motion-reduce:hidden"
					style={rise(0.25)}
				/>
				<span className="relative grid size-16 animate-bf-pop place-items-center rounded-full bg-[linear-gradient(180deg,#FFD68C,#FF4D8D)] text-[#141012] shadow-[0_18px_50px_-12px_rgba(255,77,141,0.8)] motion-reduce:animate-none">
					<Check className="size-8" strokeWidth={2.5} />
				</span>
			</div>
			<p
				className={classNames(`mt-6 text-[15px] leading-[1.5] ${DIM}`, RISE)}
				style={rise(0.3)}
			>
				Stripe has emailed your receipt.
			</p>
			<div
				className={classNames("mt-6 flex w-full flex-col gap-3", RISE)}
				style={rise(0.4)}
			>
				<Link href="/dashboard/caps" className={classNames(CLAIM, "w-full")}>
					<Sheen />
					Go to your dashboard
					<Arrow />
				</Link>
				<Link
					href={BILLING}
					className={classNames(GHOST, "!h-12 w-full !rounded-full")}
				>
					See billing
				</Link>
			</div>
		</div>
	);
}

function Message({
	body,
	action,
	onExit,
}: {
	body: string;
	action: { href: string; label: string };
	onExit: () => void;
}) {
	return (
		<div className="flex flex-col gap-6">
			<p
				className={classNames(
					"text-[15px] leading-[1.55] text-[rgba(245,241,234,0.82)]",
					RISE,
				)}
			>
				{body}
			</p>
			<a
				href={action.href}
				className={classNames(CLAIM, "w-full", RISE)}
				style={rise(0.1)}
			>
				<Sheen />
				{action.label}
				<Arrow />
			</a>
			<button
				type="button"
				onClick={onExit}
				className={`mx-auto text-[13px] underline decoration-[rgba(245,241,234,0.25)] underline-offset-[4px] transition-colors hover:text-[#F5F1EA] ${DIM}`}
			>
				Remove code
			</button>
		</div>
	);
}
