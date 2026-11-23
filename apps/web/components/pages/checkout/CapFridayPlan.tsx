"use client";

import { Logo } from "@cap/ui/logo";
import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { claimCapFriday } from "@/actions/billing/cap-friday";
import { trackEvent } from "@/app/utils/analytics";
import { CapFridayMark } from "@/components/pages/blackfriday/CapFridayMark";
import { Arrow, Sheen } from "@/components/pages/blackfriday/Claim";
import { Countdown } from "@/components/pages/blackfriday/Countdown";
import { CARD, CLAIM, DIM, GHOST } from "@/components/pages/blackfriday/theme";
import type {
	CapFridayQuote,
	CapFridayRedeemResult,
	CapFridayState,
} from "@/lib/checkout/cap-friday";
import { formatAmount } from "@/utils/currency";

const MANAGE_PLAN = "/checkout?plan=yearly";
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

export function CapFridayPlan({ state }: { state: CapFridayState }) {
	const router = useRouter();
	const [result, setResult] = useState<CapFridayRedeemResult | null>(null);
	const [paying, setPaying] = useState(false);

	if (result?.ok) {
		return (
			<Stage>
				<Done
					renewsOn={result.renewsOn}
					kind={state.type === "quote" ? state.quote.kind : "yearly"}
				/>
			</Stage>
		);
	}

	if (state.type === "redeemed") {
		return (
			<Stage>
				<Heading
					title="You've locked in Cap Friday"
					body={
						state.renewsOn
							? `Your next year of Cap Pro from ${day(state.renewsOn)} is already paid for.`
							: "Your next year of Cap Pro is already paid for."
					}
				/>
				<Actions
					primary={{ href: "/dashboard/caps", label: "Go to your dashboard" }}
				/>
			</Stage>
		);
	}

	if (state.type === "awaiting_payment") {
		return (
			<Stage>
				<Heading
					title="Finish your payment"
					body="Your bank needs you to confirm the Cap Friday payment. Nothing changes until it's paid."
				/>
				<Actions primary={{ href: state.payUrl, label: "Confirm payment" }} />
			</Stage>
		);
	}

	if (state.type === "unavailable") {
		const copy = UNAVAILABLE[state.reason];
		return (
			<Stage>
				<Heading title={copy.title} body={copy.body} />
				<Actions primary={copy.action} />
			</Stage>
		);
	}

	const { quote } = state;
	const payUrl =
		result && !result.ok && "payUrl" in result ? result.payUrl : null;
	const error =
		result && !result.ok && "message" in result ? result.message : null;

	const pay = async () => {
		if (paying) return;
		setPaying(true);
		setResult(null);
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
					"Something went wrong and nothing was charged. Try again, or email hello@cap.so.",
			}),
		);
		setResult(next);
		setPaying(false);
		if (next.ok) router.refresh();
	};

	return (
		<Stage>
			<Heading
				title={
					quote.kind === "yearly"
						? "Lock in your next year at half price"
						: "Switch to yearly at half price"
				}
				body={
					quote.kind === "yearly"
						? "Pay for your next year of Cap Pro now and it's covered the day it renews."
						: "Move to Cap Pro yearly today with the first year 50% off. We credit what's left of this month."
				}
			/>

			<div
				className={classNames(
					CARD,
					"mt-10 w-full max-w-[560px] animate-bf-rise p-6 text-left motion-reduce:animate-none sm:p-8",
				)}
				style={rise(0.7)}
			>
				<div className="flex items-baseline justify-between gap-4">
					<span className={`text-[15px] ${DIM}`}>Due today</span>
					<DueToday cents={quote.dueToday} currency={quote.currency} />
				</div>
				<p className={`mt-1 text-right text-[13px] ${DIM}`}>
					{brandName(quote.card.brand)} ending {quote.card.last4}
				</p>

				{quote.kind === "monthly" ? <Breakdown quote={quote} /> : null}

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
						className={classNames(CLAIM, "mt-8 w-full")}
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

				<p className={`mt-4 text-center text-[13px] leading-[1.5] ${DIM}`}>
					Stripe emails your receipt. <Countdown />.
				</p>
			</div>

			<Link
				href={MANAGE_PLAN}
				className={`mt-6 animate-bf-rise text-[14px] underline decoration-[rgba(245,241,234,0.25)] underline-offset-[4px] transition-colors hover:text-[#F5F1EA] motion-reduce:animate-none ${DIM}`}
				style={rise(1.1)}
			>
				Not now, manage my plan
			</Link>
		</Stage>
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

function Breakdown({
	quote,
}: {
	quote: Extract<CapFridayQuote, { kind: "monthly" }>;
}) {
	return (
		<dl className="mt-6 flex flex-col gap-2 border-t border-[rgba(245,241,234,0.1)] pt-5 text-[14px]">
			<Row
				label={`Cap Pro yearly, ${quote.seats} ${quote.seats === 1 ? "seat" : "seats"}`}
				value={money(quote.yearlyAmount, quote.currency)}
			/>
			<Row
				label="Cap Friday, 50% off"
				value={`-${money(quote.discount, quote.currency)}`}
				accent
			/>
			{quote.unusedCredit > 0 ? (
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
				style={rise(0.9)}
			/>
			{steps.map((step, index) => (
				<li
					key={step.when}
					className="relative grid animate-bf-rise grid-cols-[15px_1fr] gap-4 motion-reduce:animate-none"
					style={rise(0.95 + index * 0.25)}
				>
					<span
						aria-hidden="true"
						className="relative mt-1 grid size-[15px] animate-bf-pop place-items-center rounded-full bg-[#0A0A0B] shadow-[inset_0_0_0_1.5px_#FF7A9C,0_0_14px_rgba(255,77,141,0.55)] motion-reduce:animate-none"
						style={rise(1.05 + index * 0.25)}
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

// Counts up from zero once mounted so the amount lands with the card.
function DueToday({ cents, currency }: { cents: number; currency: string }) {
	const [value, setValue] = useState(0);
	useEffect(() => {
		const timer = window.setTimeout(() => setValue(cents / 100), 850);
		return () => window.clearTimeout(timer);
	}, [cents]);
	return (
		<span className="text-[44px] font-medium leading-none tracking-[-0.03em] tabular-nums text-[#F5F1EA]">
			<NumberFlow
				value={value}
				format={{ style: "currency", currency: currency.toUpperCase() }}
				locales="en-US"
				aria-label={money(cents, currency)}
			/>
		</span>
	);
}

function Done({
	renewsOn,
	kind,
}: {
	renewsOn: number;
	kind: CapFridayQuote["kind"];
}) {
	return (
		<>
			<div className="relative mt-10 grid place-items-center">
				<span
					aria-hidden="true"
					className="absolute size-24 animate-bf-ring rounded-full shadow-[0_0_0_2px_#FF4D8D,0_0_40px_rgba(255,77,141,0.6)] motion-reduce:hidden"
				/>
				<span
					aria-hidden="true"
					className="absolute size-24 animate-bf-ring rounded-full shadow-[0_0_0_2px_#FFD68C] motion-reduce:hidden"
					style={rise(0.25)}
				/>
				<span className="relative grid size-20 animate-bf-pop place-items-center rounded-full bg-[linear-gradient(180deg,#FFD68C,#FF4D8D)] text-[#141012] shadow-[0_18px_50px_-12px_rgba(255,77,141,0.8)] motion-reduce:animate-none">
					<Check className="size-9" strokeWidth={2.5} />
				</span>
			</div>
			<h1
				className="mt-8 animate-bf-rise text-balance text-[40px] font-medium leading-[1] tracking-[-0.035em] motion-reduce:animate-none sm:text-[56px]"
				style={rise(0.3)}
			>
				Locked in
			</h1>
			<p
				className={`mt-4 max-w-[480px] animate-bf-rise text-balance text-[17px] leading-[1.5] motion-reduce:animate-none ${DIM}`}
				style={rise(0.42)}
			>
				{kind === "yearly"
					? `Your renewal on ${day(renewsOn)} is paid for. Stripe has emailed your receipt.`
					: `You're on Cap Pro yearly. Your next renewal is ${day(renewsOn)}, and Stripe has emailed your receipt.`}
			</p>
			<div
				className="mt-8 flex animate-bf-rise flex-col gap-3 motion-reduce:animate-none sm:flex-row"
				style={rise(0.54)}
			>
				<Link href="/dashboard/caps" className={CLAIM}>
					<Sheen />
					Go to your dashboard
					<Arrow />
				</Link>
				<Link
					href={BILLING}
					className={classNames(GHOST, "!h-14 !rounded-full")}
				>
					See billing
				</Link>
			</div>
		</>
	);
}

function Heading({ title, body }: { title: string; body: string }) {
	return (
		<>
			<h1
				className="mt-6 animate-bf-rise text-balance text-[36px] font-medium leading-[1.02] tracking-[-0.035em] motion-reduce:animate-none sm:text-[54px]"
				style={rise(0.3)}
			>
				{title}
			</h1>
			<p
				className={`mt-4 max-w-[500px] animate-bf-rise text-balance text-[17px] leading-[1.5] motion-reduce:animate-none ${DIM}`}
				style={rise(0.42)}
			>
				{body}
			</p>
		</>
	);
}

function Actions({ primary }: { primary: { href: string; label: string } }) {
	return (
		<div
			className="mt-8 flex animate-bf-rise flex-col items-center gap-4 motion-reduce:animate-none"
			style={rise(0.54)}
		>
			<a href={primary.href} className={CLAIM}>
				<Sheen />
				{primary.label}
				<Arrow />
			</a>
			<Link
				href={MANAGE_PLAN}
				className={`text-[14px] underline decoration-[rgba(245,241,234,0.25)] underline-offset-[4px] transition-colors hover:text-[#F5F1EA] ${DIM}`}
			>
				Manage my plan
			</Link>
		</div>
	);
}

function Stage({ children }: { children: ReactNode }) {
	return (
		<main className="relative isolate min-h-[100svh] overflow-hidden bg-[#0A0A0B] px-4 pb-20 pt-24 text-[#F5F1EA] sm:pt-28">
			<header className="absolute inset-x-0 top-0 z-10 animate-bf-fade motion-reduce:animate-none">
				<div className="mx-auto flex h-16 w-full max-w-[1184px] items-center px-5 sm:px-8">
					<Link
						href="/blackfriday"
						className="group -ml-2 inline-flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-[14px] text-[rgba(245,241,234,0.72)] transition-colors hover:text-[#F5F1EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
					>
						<svg
							viewBox="0 0 16 16"
							aria-hidden="true"
							className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transition-none"
						>
							<path
								d="M9.75 3.75 5.5 8l4.25 4.25"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
						<Logo white className="h-auto w-[78px]" />
						<span className="sr-only">Back to Cap Friday</span>
					</Link>
				</div>
			</header>
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 -z-10 h-[760px] animate-bf-fade bg-[radial-gradient(60%_55%_at_50%_0%,rgba(255,111,142,0.24),rgba(255,179,107,0.08)_45%,rgba(10,10,11,0)_75%)] [animation-duration:1.4s] motion-reduce:animate-none"
			/>
			<div className="mx-auto flex w-full max-w-[720px] flex-col items-center text-center">
				<CapFridayMark animate className="w-[min(72vw,380px)]" />
				{children}
			</div>
		</main>
	);
}

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
