"use client";

import { classNames } from "@cap/utils/helpers";
import { CheckoutElementsProvider } from "@stripe/react-stripe-js/checkout";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	type CreateCheckoutResult,
	createProCheckout,
} from "@/actions/billing/checkout";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/pages/HomeTwo/theme";
import type { CheckoutPlan } from "@/lib/checkout/plans";
import { CHECKOUT_FONTS, checkoutAppearance } from "./appearance";
import { CheckoutForm } from "./CheckoutForm";
import {
	CARD,
	CheckoutShell,
	purchaseCopy,
	SummarySkeleton,
} from "./CheckoutShell";
import { getStripe } from "./stripe-client";

type SessionResult = Promise<CreateCheckoutResult>;

export type CheckoutViewProps = {
	session: SessionResult;
	publishableKey: string;
	email: string | null;
	plan: CheckoutPlan;
	seats: number;
	onboarding: boolean;
	priceIds: Record<CheckoutPlan, string>;
};

type FailureReason = Extract<CreateCheckoutResult, { ok: false }>["reason"];

const unavailable = (): CreateCheckoutResult => ({
	ok: false,
	reason: "unavailable",
});

export function CheckoutView({
	session: initial,
	...props
}: CheckoutViewProps) {
	const { plan, seats, onboarding } = props;
	// A retry replaces the session the page streamed in; a new page render
	// (different plan or seats in the URL) brings a fresh one and wins.
	const [retry, setRetry] = useState<{
		replaces: SessionResult;
		session: SessionResult;
		attempt: number;
	} | null>(null);
	const current = retry?.replaces === initial ? retry : null;
	const session = current?.session ?? initial;

	const onRetry = () =>
		setRetry({
			replaces: initial,
			session: createProCheckout({ plan, seats, onboarding }).catch(
				unavailable,
			),
			attempt: (current?.attempt ?? 0) + 1,
		});

	return (
		<CheckoutSession
			key={current?.attempt ?? 0}
			{...props}
			session={session}
			onRetry={onRetry}
		/>
	);
}

function CheckoutSession(
	props: Omit<CheckoutViewProps, "session"> & {
		session: SessionResult;
		onRetry: () => void;
	},
) {
	const { session, publishableKey, onboarding, onRetry } = props;
	const [failure, setFailure] = useState<FailureReason | null>(null);
	const [appearance] = useState(() =>
		checkoutAppearance(
			typeof window !== "undefined" &&
				window.matchMedia("(pointer: coarse)").matches,
		),
	);
	const copy = purchaseCopy(onboarding);

	useEffect(() => {
		let active = true;
		Promise.resolve(session).then((result) => {
			if (active && !result.ok) setFailure(result.reason);
		});
		return () => {
			active = false;
		};
	}, [session]);

	// Stripe.js loads and initialises while the session is still being
	// created, rather than waiting for the client secret first.
	const clientSecret = useMemo(() => {
		// Promises streamed from the server are bare thenables, so wrap first.
		const secret = Promise.resolve(session).then((result) =>
			result.ok
				? result.clientSecret
				: Promise.reject(new Error(result.reason)),
		);
		secret.catch(() => {});
		return secret;
	}, [session]);

	if (!failure) {
		return (
			<CheckoutElementsProvider
				stripe={getStripe(publishableKey)}
				options={{
					clientSecret,
					elementsOptions: {
						appearance,
						fonts: CHECKOUT_FONTS,
						savedPaymentMethod: { enableSave: "never" },
					},
				}}
			>
				<CheckoutForm
					clientSecret={clientSecret}
					email={props.email}
					onboarding={onboarding}
					fallback={<HostedFallback {...props} />}
				/>
			</CheckoutElementsProvider>
		);
	}

	return (
		<CheckoutShell {...copy} summary={<SummarySkeleton />}>
			{failure === "already_pro" ? (
				<Notice
					title="You're already on Cap Pro"
					body="Your subscription is active, so there's nothing to pay."
					action={
						<Link
							href="/dashboard/caps"
							className={classNames(BTN_PRIMARY, "w-full")}
						>
							Go to your dashboard
						</Link>
					}
				/>
			) : failure === "rate_limited" ? (
				<Notice
					title="Too many checkout attempts"
					body="Please wait a few minutes, then try again."
					action={
						<button
							type="button"
							onClick={onRetry}
							className={classNames(BTN_SECONDARY, "w-full")}
						>
							Try again
						</button>
					}
				/>
			) : (
				<HostedFallback {...props} />
			)}
		</CheckoutShell>
	);
}

function Notice({
	title,
	body,
	action,
	secondary,
}: {
	title: string;
	body: string;
	action: ReactNode;
	secondary?: ReactNode;
}) {
	return (
		<div role="alert" className={classNames(CARD, "flex flex-col gap-5")}>
			<div>
				<h2 className="text-[24px] font-normal leading-[1.1] tracking-[-0.02em]">
					{title}
				</h2>
				<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
					{body}
				</p>
			</div>
			{action}
			{secondary}
		</div>
	);
}

function HostedFallback({
	email,
	plan,
	seats,
	onboarding,
	priceIds,
	onRetry,
}: Omit<CheckoutViewProps, "session"> & { onRetry: () => void }) {
	const [opening, setOpening] = useState(false);
	const [failed, setFailed] = useState(false);

	const openHosted = async () => {
		setOpening(true);
		setFailed(false);
		try {
			const response = await fetch(
				email
					? "/api/settings/billing/subscribe"
					: "/api/settings/billing/guest-checkout",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						priceId: priceIds[plan],
						quantity: seats,
						isOnBoarding: onboarding,
						hosted: true,
					}),
				},
			);
			const data: { url?: string } = await response.json();
			if (data.url) {
				window.location.href = data.url;
				return;
			}
			setFailed(true);
		} catch {
			setFailed(true);
		}
		setOpening(false);
	};

	return (
		<Notice
			title="Checkout didn't load"
			body="This is usually a blocked script or a dropped connection. Nothing has been charged."
			action={
				<button
					type="button"
					onClick={onRetry}
					className={classNames(BTN_PRIMARY, "w-full")}
				>
					Try again
				</button>
			}
			secondary={
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={openHosted}
						disabled={opening}
						className={classNames(
							BTN_SECONDARY,
							"w-full disabled:cursor-not-allowed disabled:opacity-60",
						)}
					>
						{opening ? "Opening Stripe..." : "Pay on Stripe instead"}
					</button>
					{failed ? (
						<p className="text-center text-[13px] text-[#B4322E]">
							That didn't work either. Email hello@cap.so and we'll sort it out.
						</p>
					) : null}
				</div>
			}
		/>
	);
}
