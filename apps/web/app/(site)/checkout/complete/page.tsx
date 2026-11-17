import { getCurrentUser } from "@cap/database/auth/session";
import { buildEnv, serverEnv } from "@cap/env";
import { classNames } from "@cap/utils/helpers";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
	PlanFeatures,
	PlanHeading,
} from "@/components/pages/checkout/CheckoutForm";
import { CARD, CheckoutShell } from "@/components/pages/checkout/CheckoutShell";
import { SwitchAccountButton } from "@/components/pages/checkout/SwitchAccountButton";
import { BTN_PRIMARY } from "@/components/pages/HomeTwo/theme";
import {
	type CheckoutEnvironment,
	checkoutPath,
	planForPriceId,
} from "@/lib/checkout/plans";
import { type CheckoutSession, checkoutStripe } from "@/lib/checkout/stripe";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Checkout | Cap",
	robots: { index: false, follow: false },
};

async function loadSession(sessionId: string | undefined) {
	if (!sessionId?.startsWith("cs_")) return null;
	try {
		const session = await checkoutStripe().checkout.sessions.retrieve(
			sessionId,
			{ expand: ["line_items"] },
		);
		return session.metadata?.checkoutUi === "elements" ? session : null;
	} catch (error) {
		console.error("Failed to load completed checkout session:", error);
		return null;
	}
}

const retryPath = (session: CheckoutSession) => {
	const environment: CheckoutEnvironment =
		serverEnv().VERCEL_ENV === "production" ? "production" : "development";
	const lineItem = session.line_items?.data[0];
	return checkoutPath({
		plan: planForPriceId(lineItem?.price?.id, environment) ?? "monthly",
		seats: lineItem?.quantity ?? 1,
		onboarding: session.metadata?.isOnBoarding === "true",
	});
};

export default async function CheckoutCompletePage(props: {
	searchParams: Promise<{ session_id?: string | string[] }>;
}) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") redirect("/pricing");

	const searchParams = await props.searchParams;
	const sessionId = Array.isArray(searchParams.session_id)
		? searchParams.session_id[0]
		: searchParams.session_id;
	const [session, user] = await Promise.all([
		loadSession(sessionId),
		getCurrentUser(),
	]);

	if (!session) redirect("/pricing");

	const paid =
		session.status === "complete" && session.payment_status !== "unpaid";
	const ownsSession = Boolean(
		user && session.metadata?.dubCustomerId === user.id,
	);

	if (paid && ownsSession) {
		redirect(
			session.metadata?.isOnBoarding === "true"
				? `/dashboard/settings/organization?upgrade=true&session_id=${session.id}`
				: `/dashboard/caps?upgrade=true&session_id=${session.id}`,
		);
	}

	const email = session.customer_details?.email ?? null;
	const lineItem = session.line_items?.data[0];
	const seats = lineItem?.quantity ?? 1;
	const loginHref = `/login?${new URLSearchParams({
		next: `/dashboard/caps?upgrade=true&session_id=${session.id}`,
		...(email ? { email } : {}),
	}).toString()}`;

	const yearly = lineItem?.price?.recurring?.interval === "year";
	const state = paid
		? {
				title: "You're on Cap Pro",
				subtitle: "Thanks for supporting Cap. Your workspace is ready.",
			}
		: session.status === "complete"
			? {
					title: "Your payment is processing",
					subtitle: "Some payment methods take a little longer to confirm.",
				}
			: {
					title: "Your payment didn't go through",
					subtitle: "Nothing has been charged.",
				};

	return (
		<CheckoutShell
			title={state.title}
			subtitle={state.subtitle}
			summary={
				<>
					<PlanHeading tag={paid ? "Paid" : "Cap Pro"} />
					<dl className="mt-6 flex flex-col gap-2.5 border-t border-[#E1E7EE] pt-5 text-[14px]">
						<div className="flex items-baseline justify-between gap-4">
							<dt className="text-[rgba(17,17,17,0.66)]">Seats</dt>
							<dd className="tabular-nums">
								{seats} {seats === 1 ? "seat" : "seats"}
							</dd>
						</div>
						<div className="flex items-baseline justify-between gap-4">
							<dt className="text-[rgba(17,17,17,0.66)]">Billing</dt>
							<dd>{yearly ? "Yearly" : "Monthly"}</dd>
						</div>
						{email ? (
							<div className="flex items-baseline justify-between gap-4">
								<dt className="text-[rgba(17,17,17,0.66)]">Receipts to</dt>
								<dd className="truncate">{email}</dd>
							</div>
						) : null}
					</dl>
					<PlanFeatures />
				</>
			}
		>
			<div className={classNames(CARD, "flex flex-col gap-6")}>
				{paid ? (
					<>
						<span className="grid size-11 place-items-center rounded-full bg-[#E1EFFE] text-[#3D77C2]">
							<Check className="size-5" strokeWidth={2.25} />
						</span>
						<div>
							<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
								Sign in to get started
							</h2>
							<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
								{email
									? `Your Cap account uses ${email}. Sign in with it to start recording and sharing.`
									: "Sign in with the email you paid with to start recording and sharing."}
							</p>
						</div>
						{user ? (
							<SwitchAccountButton
								loginHref={loginHref}
								className={classNames(BTN_PRIMARY, "w-full")}
							/>
						) : (
							<Link
								href={loginHref}
								className={classNames(BTN_PRIMARY, "w-full")}
							>
								Sign in to Cap
							</Link>
						)}
					</>
				) : session.status === "complete" ? (
					<div>
						<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
							We'll switch Cap Pro on automatically
						</h2>
						<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
							As soon as the payment clears, Cap Pro turns on and Stripe sends
							the receipt to {email ?? "your email"}.
						</p>
					</div>
				) : (
					<>
						<div>
							<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em]">
								{session.status === "expired"
									? "This checkout has expired"
									: "Try another payment method"}
							</h2>
							<p className="mt-2.5 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.66)]">
								You can try again with the same card or a different one.
							</p>
						</div>
						<Link
							href={retryPath(session)}
							className={classNames(BTN_PRIMARY, "w-full")}
						>
							Try again
						</Link>
					</>
				)}
			</div>
		</CheckoutShell>
	);
}
