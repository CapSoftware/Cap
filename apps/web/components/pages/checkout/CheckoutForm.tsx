"use client";

import { classNames } from "@cap/utils/helpers";
import {
	BillingAddressElement,
	ExpressCheckoutElement,
	PaymentElement,
	TaxIdElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { StripeExpressCheckoutElementConfirmEvent } from "@stripe/stripe-js";
import { Check, Loader2, Minus, Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useState,
} from "react";
import { changeProCheckoutPlan } from "@/actions/billing/checkout";
import { trackEvent } from "@/app/utils/analytics";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	MODE_THEME,
} from "@/components/pages/HomeTwo/theme";
import { Segmented } from "@/components/pages/pricing/controls";
import { homepageCopy } from "@/data/homepage-copy";
import type { CheckoutPlan } from "@/lib/checkout/plans";
import { MAX_CHECKOUT_QUANTITY } from "@/lib/checkout-quantity";
import {
	CARD,
	CheckoutShell,
	PaymentSkeleton,
	purchaseCopy,
	SummarySkeleton,
} from "./CheckoutShell";

type Checkout = Extract<
	ReturnType<typeof useCheckoutElements>,
	{ type: "success" }
>["checkout"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEAT_COMMIT_DELAY_MS = 400;
const HIGHLIGHTS = homepageCopy.pricing.pro.features.slice(1, 5);

const hasCompanyDetails = (checkout: Checkout) =>
	Boolean(
		checkout.nameCollection?.businessName?.trim() ||
			checkout.taxIdInfo?.businessName?.trim() ||
			checkout.taxIdInfo?.taxId?.value?.trim(),
	);

// Tiered prices report a zero unit amount, so the per-user figure comes from
// the line subtotal instead.
const perUserAmount = (
	checkout: Checkout,
	lineItem: Checkout["lineItems"][number],
) => {
	if (lineItem.unitAmount.minorUnitsAmount > 0 || lineItem.quantity < 1) {
		return lineItem.unitAmount.amount;
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: checkout.currency,
	}).format(
		lineItem.subtotal.minorUnitsAmount /
			lineItem.quantity /
			checkout.minorUnitsAmountDivisor,
	);
};

const INPUT =
	"h-[44px] w-full rounded-[10px] border border-[#D3DCE6] bg-white px-3 text-[16px] text-[#111111] shadow-[0_1px_1px_rgba(17,17,17,0.03)] sm:text-[15px] outline-none transition-[border-color,box-shadow] placeholder:text-[rgba(17,17,17,0.38)] hover:border-[#B9C6D4] focus:border-[#55A0EA] focus:shadow-[0_0_0_3px_rgba(85,160,234,0.22)] aria-[invalid=true]:border-[#B4322E]";

const LABEL = "text-[13px] font-medium text-[rgba(17,17,17,0.72)]";

const INCOMPLETE_FIELDS: Partial<Record<string, string>> = {
	payment: "Finish your payment details.",
	taxId: "Add your company name, or turn off company details.",
	billingAddress: "Finish your company address, or turn off company details.",
};

export function CheckoutForm({
	clientSecret,
	email,
	onboarding,
	fallback,
}: {
	clientSecret: Promise<string>;
	email: string | null;
	onboarding: boolean;
	fallback: ReactNode;
}) {
	const state = useCheckoutElements();
	const copy = purchaseCopy(onboarding);
	const [seatsPending, setSeatsPending] = useState(false);

	if (state.type === "loading") {
		return (
			<CheckoutShell {...copy} summary={<SummarySkeleton />}>
				<PaymentSkeleton />
			</CheckoutShell>
		);
	}

	if (state.type === "error") {
		return (
			<CheckoutShell {...copy} summary={<SummarySkeleton />}>
				{fallback}
			</CheckoutShell>
		);
	}

	const { checkout } = state;

	if (checkout.status.type !== "open") {
		const complete = checkout.status.type === "complete";
		return (
			<CheckoutShell {...copy} summary={<SummarySkeleton />}>
				<div role="alert" className={classNames(CARD, "flex flex-col gap-5")}>
					<div>
						<h2 className="text-[24px] font-normal leading-[1.1] tracking-[-0.02em]">
							{complete
								? "This checkout is already paid"
								: "This checkout has expired"}
						</h2>
						<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
							{complete
								? "Your Cap Pro subscription is set up. Head to your dashboard to get started."
								: "Checkouts close after a while for your security. Start a fresh one below."}
						</p>
					</div>
					{complete ? (
						<Link
							href="/dashboard/caps"
							className={classNames(BTN_PRIMARY, "w-full")}
						>
							Go to your dashboard
						</Link>
					) : (
						<button
							type="button"
							onClick={() => window.location.reload()}
							className={classNames(BTN_PRIMARY, "w-full")}
						>
							Start a new checkout
						</button>
					)}
				</div>
			</CheckoutShell>
		);
	}

	return (
		<CheckoutShell
			{...copy}
			summary={
				<OrderSummary
					checkout={checkout}
					clientSecret={clientSecret}
					onSeatsPendingChange={setSeatsPending}
				/>
			}
		>
			<PaymentForm
				checkout={checkout}
				email={email}
				seatsPending={seatsPending}
			/>
		</CheckoutShell>
	);
}

function OrderSummary({
	checkout,
	clientSecret,
	onSeatsPendingChange,
}: {
	checkout: Checkout;
	clientSecret: Promise<string>;
	onSeatsPendingChange: (pending: boolean) => void;
}) {
	const lineItem = checkout.lineItems[0];
	const plan: CheckoutPlan =
		lineItem?.recurring?.interval === "year" ? "yearly" : "monthly";
	const [pendingPlan, setPendingPlan] = useState<CheckoutPlan | null>(null);
	const [planError, setPlanError] = useState(false);

	if (!lineItem) return <SummarySkeleton />;

	const yearly = (pendingPlan ?? plan) === "yearly";
	const period = plan === "yearly" ? "year" : "month";
	const renewal = checkout.recurring?.dueNext.total.amount;

	const changePlan = async (next: CheckoutPlan) => {
		if (next === plan || pendingPlan) return;
		setPendingPlan(next);
		setPlanError(false);
		try {
			const result = await checkout.runServerUpdate(async () => {
				const update = await changeProCheckoutPlan({
					clientSecret: await clientSecret,
					plan: next,
				});
				if (!update.ok) throw new Error("Plan change was rejected");
			});
			if (result.type === "error") setPlanError(true);
		} catch {
			setPlanError(true);
		}
		setPendingPlan(null);
	};

	return (
		<div className="flex flex-col">
			<PlanHeading tag="Most popular" />

			<div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1.5 sm:mt-6">
				<span className="whitespace-nowrap text-[38px] sm:text-[46px] font-normal leading-none tracking-[-0.03em] tabular-nums">
					{perUserAmount(checkout, lineItem)}
				</span>
				<span className="text-[14px] text-[rgba(17,17,17,0.5)]">
					per user, per {period}
				</span>
				{pendingPlan ? (
					<Loader2
						aria-label="Updating plan"
						className="size-4 animate-spin self-center text-[rgba(17,17,17,0.5)]"
					/>
				) : null}
			</div>

			<div className="mt-4 space-y-3 sm:mt-6">
				<Segmented
					ariaLabel="Billing cycle"
					value={yearly ? "yearly" : "monthly"}
					onChange={(value) => changePlan(value as CheckoutPlan)}
					options={[
						{ value: "monthly", label: "Monthly" },
						{ value: "yearly", label: "Annual", badge: "Save 32%" },
					]}
					theme={MODE_THEME.instant}
				/>
				<SeatControl
					checkout={checkout}
					lineItemId={lineItem.id}
					onPendingChange={onSeatsPendingChange}
				/>
				{planError ? (
					<p role="alert" className="text-[13px] text-[#B4322E]">
						Couldn't switch plans. Please try again.
					</p>
				) : null}
			</div>

			<dl className="mt-6 flex flex-col gap-2.5 border-t border-[#E1E7EE] pt-5 text-[14px]">
				<Row
					label={`Cap Pro × ${lineItem.quantity} ${lineItem.quantity === 1 ? "user" : "users"}`}
					value={checkout.total.subtotal.amount}
				/>
				{checkout.discountAmounts?.map((discount) => (
					<Row
						key={`${discount.displayName}-${discount.promotionCode ?? ""}`}
						label={discount.promotionCode ?? discount.displayName}
						value={`-${discount.amount}`}
						tone="discount"
					/>
				))}
				{checkout.taxAmounts
					?.filter((tax) => !tax.inclusive)
					.map((tax) => (
						<Row
							key={tax.displayName}
							label={
								tax.percentage
									? `${tax.displayName} (${tax.percentage}%)`
									: tax.displayName
							}
							value={tax.amount}
						/>
					))}
				<Row
					label="Due today"
					value={checkout.total.total.amount}
					tone="total"
				/>
			</dl>

			<PromotionCode checkout={checkout} />

			{renewal ? (
				<p className="mt-4 text-[13px] leading-[1.5] text-[rgba(17,17,17,0.5)]">
					Then {renewal} every {period}. Cancel anytime.
				</p>
			) : null}

			<PlanFeatures />
		</div>
	);
}

export function PlanHeading({ tag }: { tag: string }) {
	const theme = MODE_THEME.instant;
	return (
		<>
			<div className="flex items-start justify-between gap-3">
				<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
					Cap Pro
				</h2>
				<span
					className="shrink-0 rounded-full px-2.5 py-[6px] text-[12px] font-medium leading-none tracking-[-0.01em]"
					style={{ background: theme.chip, color: theme.glyph }}
				>
					{tag}
				</span>
			</div>
			<p
				className={`${BODY_TEXT} mt-3 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.72)] max-sm:hidden`}
			>
				Everything in Desktop, plus unlimited cloud sharing, AI, and team
				collaboration.
			</p>
		</>
	);
}

export function PlanFeatures() {
	const theme = MODE_THEME.instant;
	return (
		<div className="mt-7 hidden border-t border-[#E1E7EE] pt-6 lg:block">
			<p className="text-[13px] font-medium">
				Everything in Desktop License, plus:
			</p>
			<ul className="mt-4 space-y-3">
				{HIGHLIGHTS.map((feature) => (
					<li key={feature} className="flex items-start gap-3">
						<span
							className="mt-px grid size-5 shrink-0 place-items-center rounded-full"
							style={{ background: theme.chip, color: theme.glyph }}
						>
							<Check className="size-3" strokeWidth={2.5} />
						</span>
						<span className="text-[14px] leading-snug text-[rgba(17,17,17,0.72)]">
							{feature}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Row({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "discount" | "total";
}) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<dt
				className={
					tone === "total"
						? "font-medium text-[#111111]"
						: "text-[rgba(17,17,17,0.66)]"
				}
			>
				{label}
			</dt>
			<dd
				className={classNames(
					"tabular-nums",
					tone === "total"
						? "text-[16px] font-medium text-[#111111]"
						: tone === "discount"
							? "text-[#2F7D5B]"
							: "text-[#111111]",
				)}
			>
				{value}
			</dd>
		</div>
	);
}

const STEP_BTN =
	"grid size-8 shrink-0 place-items-center rounded-full bg-[#EDF1F6] text-[#111111] transition-colors duration-200 hover:bg-[#DCE4EC] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#EDF1F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]";

function SeatControl({
	checkout,
	lineItemId,
	onPendingChange,
}: {
	checkout: Checkout;
	lineItemId: string;
	onPendingChange: (pending: boolean) => void;
}) {
	const quantity =
		checkout.lineItems.find((item) => item.id === lineItemId)?.quantity ?? 1;
	const inputId = useId();
	const [draft, setDraft] = useState(String(quantity));
	const [failed, setFailed] = useState(false);
	const seats = Number(draft);
	const valid =
		Number.isInteger(seats) && seats >= 1 && seats <= MAX_CHECKOUT_QUANTITY;

	useEffect(() => {
		setDraft(String(quantity));
	}, [quantity]);

	// A chosen count only reaches Stripe after the debounce and the update
	// request, so payment waits until the session's quantity matches it.
	const pending = valid && seats !== quantity;
	useEffect(() => {
		onPendingChange(pending);
	}, [onPendingChange, pending]);

	useEffect(() => {
		if (!valid || seats === quantity) return;
		const timer = setTimeout(async () => {
			const result = await checkout.updateLineItemQuantity({
				lineItem: lineItemId,
				quantity: seats,
			});
			setFailed(result.type === "error");
			if (result.type === "error") setDraft(String(quantity));
		}, SEAT_COMMIT_DELAY_MS);
		return () => clearTimeout(timer);
	}, [checkout, lineItemId, quantity, seats, valid]);

	const step = (delta: number) => {
		const base = valid ? seats : quantity;
		setDraft(
			String(Math.min(MAX_CHECKOUT_QUANTITY, Math.max(1, base + delta))),
		);
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-3">
				<label
					htmlFor={inputId}
					className="text-[14px] text-[rgba(17,17,17,0.72)]"
				>
					Users
				</label>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => step(-1)}
						disabled={valid && seats <= 1}
						className={STEP_BTN}
						aria-label="Remove a user"
					>
						<Minus className="size-3.5" strokeWidth={2} />
					</button>
					<input
						id={inputId}
						inputMode="numeric"
						value={draft}
						onChange={(event) =>
							setDraft(event.target.value.replace(/\D/g, "").slice(0, 5))
						}
						onBlur={() => {
							if (!valid) setDraft(String(quantity));
						}}
						aria-invalid={!valid}
						className="h-8 w-12 rounded-[8px] bg-transparent text-center text-[16px] font-medium tabular-nums text-[#111111] outline-none focus:bg-white focus:shadow-[0_0_0_2px_rgba(85,160,234,0.35)]"
					/>
					<button
						type="button"
						onClick={() => step(1)}
						disabled={valid && seats >= MAX_CHECKOUT_QUANTITY}
						className={STEP_BTN}
						aria-label="Add a user"
					>
						<Plus className="size-3.5" strokeWidth={2} />
					</button>
				</div>
			</div>
			{failed ? (
				<p role="alert" className="text-[13px] text-[#B4322E]">
					Couldn't update the number of users. Please try again.
				</p>
			) : null}
		</div>
	);
}

function PromotionCode({ checkout }: { checkout: Checkout }) {
	const applied = checkout.discountAmounts?.find(
		(discount) => discount.promotionCode,
	);
	const inputId = useId();
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (applied?.promotionCode) {
		return (
			<div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-white/80 bg-white/55 px-3 py-2 text-[13px]">
				<span className="text-[rgba(17,17,17,0.72)]">
					<span className="font-medium text-[#111111]">
						{applied.promotionCode}
					</span>{" "}
					applied
				</span>
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await checkout.removePromotionCode();
						setBusy(false);
					}}
					className="grid size-6 place-items-center rounded-full text-[rgba(17,17,17,0.55)] hover:bg-white hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
					aria-label={`Remove ${applied.promotionCode}`}
				>
					<X className="size-3.5" strokeWidth={2} />
				</button>
			</div>
		);
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="mt-4 self-start rounded-[8px] text-[13px] font-medium text-[#3D77C2] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
			>
				Add a promotion code
			</button>
		);
	}

	const apply = async (event: FormEvent) => {
		event.preventDefault();
		const value = code.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		const result = await checkout.applyPromotionCode(value);
		setBusy(false);
		if (result.type === "error") {
			setError(result.error.message);
			return;
		}
		setCode("");
		setOpen(false);
	};

	return (
		<form onSubmit={apply} className="mt-4 flex flex-col gap-1.5">
			<label htmlFor={inputId} className="sr-only">
				Promotion code
			</label>
			<div className="flex gap-2">
				<input
					id={inputId}
					value={code}
					onChange={(event) => setCode(event.target.value)}
					placeholder="Promotion code"
					autoComplete="off"
					autoCapitalize="characters"
					spellCheck={false}
					aria-invalid={Boolean(error)}
					className={classNames(INPUT, "h-[40px] uppercase")}
				/>
				<button
					type="submit"
					disabled={busy || !code.trim()}
					className={classNames(
						BTN_SECONDARY,
						"h-[40px] shrink-0 px-4 text-[14px] disabled:cursor-not-allowed disabled:opacity-50",
					)}
				>
					{busy ? "Applying..." : "Apply"}
				</button>
			</div>
			{error ? (
				<p role="alert" className="text-[13px] text-[#B4322E]">
					{error}
				</p>
			) : null}
		</form>
	);
}

function PaymentForm({
	checkout,
	email,
	seatsPending,
}: {
	checkout: Checkout;
	email: string | null;
	seatsPending: boolean;
}) {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const signedIn = Boolean(email);
	const emailId = useId();
	const [guestEmail, setGuestEmail] = useState(checkout.email ?? "");
	const [emailError, setEmailError] = useState<string | null>(null);
	const [company, setCompany] = useState(hasCompanyDetails(checkout));
	const [walletsAvailable, setWalletsAvailable] = useState(false);
	// Phones get one full-width wallet button (Apple Pay on iPhone, Google Pay
	// on Android) instead of two squeezed side by side.
	const [narrow] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(max-width: 639px)").matches,
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(
		checkout.lastPaymentError?.message ?? null,
	);

	const lineItem = checkout.lineItems[0];
	const period = lineItem?.recurring?.interval === "year" ? "year" : "month";
	const renewal =
		checkout.recurring?.dueNext.total.amount ?? checkout.total.total.amount;
	const loginHref = `/login?next=${encodeURIComponent(
		`${pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`,
	)}`;

	const commitEmail = async () => {
		if (signedIn) return true;
		const value = guestEmail.trim().toLowerCase();
		if (!EMAIL_PATTERN.test(value)) {
			setEmailError("Enter the email you'd like to use for Cap.");
			return false;
		}
		if (value === checkout.email) return true;
		const result = await checkout.updateEmail(value);
		if (result.type === "error") {
			setEmailError(result.error.message);
			return false;
		}
		setEmailError(null);
		return true;
	};

	const confirm = async (
		expressCheckoutConfirmEvent?: StripeExpressCheckoutElementConfirmEvent,
	) => {
		setError(null);
		setSubmitting(true);
		if (!expressCheckoutConfirmEvent) {
			// Stripe's own message ("This field is incomplete.") doesn't say
			// which section, and the field may be scrolled out of view.
			const validation = await checkout.validateElements();
			if (
				validation.type === "error" &&
				validation.error.code === "validation_error"
			) {
				const element = validation.error.validation_errors[0]?.element;
				setError(
					(element && INCOMPLETE_FIELDS[element]) ?? validation.error.message,
				);
				setSubmitting(false);
				return;
			}
		}
		trackEvent("checkout_payment_submitted", {
			method: expressCheckoutConfirmEvent ? "express" : "form",
			authenticated: signedIn,
			company,
		});
		const result = await checkout.confirm(
			expressCheckoutConfirmEvent ? { expressCheckoutConfirmEvent } : undefined,
		);
		if (result.type === "error") {
			setError(result.error.message);
			setSubmitting(false);
			trackEvent("checkout_payment_failed", {
				method: expressCheckoutConfirmEvent ? "express" : "form",
				code: result.error.code ?? "unknown",
			});
		}
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (submitting || seatsPending) return;
		if (!(await commitEmail())) return;
		await confirm();
	};

	const toggleCompany = async () => {
		const next = !company;
		setCompany(next);
		if (!next && hasCompanyDetails(checkout)) {
			await checkout.updateTaxIdInfo(null);
		}
	};

	return (
		<form
			onSubmit={submit}
			noValidate
			className={classNames(CARD, "flex flex-col")}
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
						Payment
					</h2>
					<p className="mt-2 text-[14px] leading-[1.5] text-[rgba(17,17,17,0.6)] max-sm:hidden">
						Cap Pro turns on the moment your payment goes through.
					</p>
				</div>
				{checkout.livemode ? null : (
					<span className="shrink-0 rounded-full bg-[#FFF1D6] px-2.5 py-[6px] text-[12px] font-medium leading-none text-[#8A5A00]">
						Test mode
					</span>
				)}
			</div>

			<div
				aria-disabled={seatsPending}
				className={classNames(
					walletsAvailable ? "mt-7" : "mt-0",
					seatsPending && "pointer-events-none opacity-60",
				)}
			>
				<ExpressCheckoutElement
					options={{
						buttonHeight: 48,
						buttonTheme: { applePay: "black", googlePay: "black" },
						buttonType: { applePay: "subscribe", googlePay: "subscribe" },
						layout: {
							maxColumns: narrow ? 1 : 2,
							maxRows: 1,
							overflow: "auto",
						},
						paymentMethodOrder: ["apple_pay", "google_pay", "link"],
						paymentMethods: { applePay: "auto", googlePay: "auto" },
					}}
					onReady={(event) =>
						setWalletsAvailable(Boolean(event.availablePaymentMethods))
					}
					onConfirm={(event) =>
						seatsPending ? event.paymentFailed() : confirm(event)
					}
				/>
			</div>
			{walletsAvailable ? (
				<div className="mt-6 flex items-center gap-3 text-[13px] text-[rgba(17,17,17,0.5)]">
					<span className="h-px flex-1 bg-[#E1E7EE]" />
					Or pay with card
					<span className="h-px flex-1 bg-[#E1E7EE]" />
				</div>
			) : null}

			<section className="mt-7 flex flex-col gap-1.5">
				{signedIn ? (
					<>
						<span className={LABEL}>Account</span>
						<div className="flex h-[44px] items-center gap-2 rounded-[10px] bg-[#F3F6FA] px-3 text-[15px]">
							<Check
								className="size-4 shrink-0 text-[#3D77C2]"
								strokeWidth={2.25}
							/>
							<span className="truncate">{email}</span>
						</div>
					</>
				) : (
					<>
						<label htmlFor={emailId} className={LABEL}>
							Email
						</label>
						<input
							id={emailId}
							type="email"
							autoComplete="email"
							inputMode="email"
							value={guestEmail}
							onChange={(event) => {
								setGuestEmail(event.target.value);
								if (emailError) setEmailError(null);
							}}
							onBlur={() => {
								if (guestEmail.trim()) commitEmail();
							}}
							placeholder="you@company.com"
							aria-invalid={Boolean(emailError)}
							aria-describedby={`${emailId}-hint`}
							className={INPUT}
						/>
						<p
							id={`${emailId}-hint`}
							className={classNames(
								"text-[13px] leading-[1.45]",
								emailError ? "text-[#B4322E]" : "text-[rgba(17,17,17,0.55)]",
							)}
						>
							{emailError ?? (
								<>
									You'll sign in to Cap with this email. Already have an
									account?{" "}
									<Link
										href={loginHref}
										className="font-medium text-[#3D77C2] underline-offset-4 hover:underline"
									>
										Sign in
									</Link>
								</>
							)}
						</p>
					</>
				)}
			</section>

			<section className="mt-6">
				<PaymentElement
					options={{
						layout: { type: "tabs" },
						// Wallets and Link live in the express buttons above; inside the
						// card form Link adds a large "save my info" sign-up block.
						wallets: { applePay: "never", googlePay: "never", link: "never" },
						// The terms line under the subscribe button already covers the
						// recurring charge, so Stripe's own mandate paragraph is dropped.
						terms: { card: "never" },
					}}
				/>
			</section>

			<section className="mt-6 flex flex-col gap-4">
				<button
					type="button"
					role="switch"
					aria-checked={company}
					onClick={toggleCompany}
					className="group flex items-start gap-3 rounded-[12px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4"
				>
					<span
						aria-hidden
						className={classNames(
							"mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200",
							company ? "bg-[#3D77C2]" : "bg-[#D3DCE6]",
						)}
					>
						<span
							className={classNames(
								"size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(17,17,17,0.2)] transition-transform duration-200",
								company ? "translate-x-4" : "translate-x-0",
							)}
						/>
					</span>
					<span className="flex flex-col gap-0.5">
						<span className="text-[15px] font-medium">
							I'm buying for a company
						</span>
						<span className="text-[13px] leading-[1.45] text-[rgba(17,17,17,0.55)]">
							Add your company name, address and tax ID to every invoice.
						</span>
					</span>
				</button>
				{company ? (
					<div className="flex flex-col gap-4 rounded-[14px] border border-[#E1E7EE] bg-[#FAFBFD] p-4">
						<TaxIdElement
							options={{
								visibility: "always",
								fields: { businessName: "always" },
								validation: {
									businessName: { required: "always" },
									taxId: { required: "never" },
								},
							}}
						/>
						<BillingAddressElement />
					</div>
				) : null}
			</section>

			{error ? (
				<p
					role="alert"
					className="mt-6 rounded-[12px] border border-[rgba(180,50,46,0.2)] bg-[#FDF3F2] px-3.5 py-3 text-[14px] leading-[1.45] text-[#8F2724]"
				>
					{error}
				</p>
			) : null}

			<button
				type="submit"
				disabled={submitting || seatsPending}
				className={classNames(
					BTN_PRIMARY,
					"mt-7 w-full gap-2 disabled:cursor-not-allowed disabled:opacity-70",
				)}
			>
				{submitting ? (
					<>
						<Loader2 className="size-4 animate-spin" strokeWidth={2} />
						Processing payment...
					</>
				) : seatsPending ? (
					<>
						<Loader2 className="size-4 animate-spin" strokeWidth={2} />
						Updating total...
					</>
				) : (
					`Subscribe for ${checkout.total.total.amount}`
				)}
			</button>

			<p className="mt-4 text-[12.5px] leading-[1.55] text-[rgba(17,17,17,0.55)]">
				By subscribing you agree to Cap's{" "}
				<Link href="/terms" className="underline underline-offset-2">
					Terms
				</Link>{" "}
				and{" "}
				<Link href="/privacy" className="underline underline-offset-2">
					Privacy Policy
				</Link>
				. You'll be charged {renewal} every {period} until you cancel. Your bank
				may ask you to confirm the payment.
			</p>
		</form>
	);
}
