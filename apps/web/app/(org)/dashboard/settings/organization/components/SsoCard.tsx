"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
} from "@cap/ui";
import { useCurrency } from "hooks/useCurrency";
import { Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import {
	confirmOrganizationSsoCheckout,
	getOrganizationSsoSettings,
	manageOrganizationSsoBilling,
	type OrganizationSsoSettings,
	openOrganizationSsoPortal,
	startOrganizationSsoCheckout,
} from "@/actions/organization/sso";
import {
	formatAmount,
	isSupportedCurrency,
	type SupportedCurrency,
} from "@/utils/currency";

type SsoAction = "checkout" | "portal" | "billing" | "refresh" | "confirm";

const actionErrors: Record<SsoAction, string> = {
	checkout: "We couldn't open checkout. Please try again or contact support.",
	portal: "We couldn't open SSO setup. Please try again or contact support.",
	billing: "We couldn't open billing. Please try again or contact support.",
	refresh: "We couldn't refresh SSO status. Please try again.",
	confirm:
		"We couldn't confirm your SSO subscription yet. Refresh the status to try again, or contact support if you've been charged.",
};

export function SsoCard({
	initialSettings,
	checkoutSessionId,
}: {
	initialSettings: OrganizationSsoSettings;
	checkoutSessionId?: string;
}) {
	const router = useRouter();
	const { currency: detectedCurrency } = useCurrency();
	const [settings, setSettings] = useState(initialSettings);
	const [domain, setDomain] = useState(initialSettings.suggestedDomain);
	const [selectedCurrency, setSelectedCurrency] =
		useState<SupportedCurrency | null>(null);
	const [pendingAction, setPendingAction] = useState<SsoAction | null>(
		checkoutSessionId ? "confirm" : null,
	);
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();
	const actionInFlight = useRef(false);
	const confirmationStarted = useRef<string | null>(null);
	const confirmedCheckout = useRef<string | null>(null);
	const domainInputId = useId();
	const currencyInputId = useId();
	const signInLinkInputId = useId();
	const organizationId = initialSettings.organizationId;
	const busy = isPending || pendingAction !== null;
	const price =
		settings.prices.find(
			(candidate) =>
				candidate.currency === (selectedCurrency ?? detectedCurrency),
		) ??
		settings.prices.find((candidate) => candidate.currency === "usd") ??
		settings.prices[0];
	const monthlyAmount = price
		? formatAmount(price.unitAmount / 100, price.currency)
		: null;
	const hasVerifiedDomain = settings.domains.some(
		(entry) => entry.state === "verified",
	);
	const isActive =
		settings.entitled &&
		settings.connection?.state === "active" &&
		hasVerifiedDomain;
	const hasExistingSubscription =
		settings.hasSubscription &&
		settings.subscriptionStatus !== "canceled" &&
		settings.subscriptionStatus !== "incomplete_expired";
	const periodEnd = settings.currentPeriodEnd
		? new Date(settings.currentPeriodEnd)
		: null;
	const periodEndLabel =
		periodEnd && !Number.isNaN(periodEnd.getTime())
			? `on ${periodEnd.toLocaleDateString("en-GB", {
					day: "numeric",
					month: "long",
					year: "numeric",
					timeZone: "UTC",
				})}`
			: "at the end of your billing period";
	let statusLabel = "Optional add-on";
	if (settings.entitled) {
		statusLabel = isActive ? "Active" : "Ready to configure";
	} else if (hasExistingSubscription) {
		statusLabel = "Billing needs attention";
	}

	const runAction = useCallback(
		(action: SsoAction, operation: () => Promise<void>) => {
			if (actionInFlight.current) return;
			actionInFlight.current = true;
			setPendingAction(action);
			setError(null);
			startTransition(async () => {
				let succeeded = false;
				try {
					await operation();
					succeeded = true;
				} catch {
					setError(actionErrors[action]);
				} finally {
					if (!succeeded || action === "refresh" || action === "confirm") {
						actionInFlight.current = false;
						setPendingAction(null);
					}
				}
			});
		},
		[],
	);

	const confirmCheckout = useCallback(
		(sessionId: string) => {
			runAction("confirm", async () => {
				const updated = await confirmOrganizationSsoCheckout(
					organizationId,
					sessionId,
				);
				setSettings(updated);
				if (!updated.entitled) {
					setError(
						"Your payment is still being confirmed. Refresh the status shortly; you don't need to subscribe again.",
					);
					return;
				}
				confirmedCheckout.current = sessionId;
				const url = new URL(window.location.href);
				url.searchParams.delete("sso_checkout");
				router.replace(`${url.pathname}${url.search}${url.hash}`, {
					scroll: false,
				});
				router.refresh();
			});
		},
		[organizationId, router, runAction],
	);

	const refreshSettings = useCallback(() => {
		if (checkoutSessionId && confirmedCheckout.current !== checkoutSessionId) {
			confirmCheckout(checkoutSessionId);
			return;
		}
		runAction("refresh", async () => {
			setSettings(await getOrganizationSsoSettings(organizationId));
			router.refresh();
		});
	}, [checkoutSessionId, confirmCheckout, organizationId, router, runAction]);

	useEffect(() => {
		if (
			!checkoutSessionId ||
			confirmationStarted.current === checkoutSessionId
		) {
			return;
		}
		confirmationStarted.current = checkoutSessionId;
		confirmCheckout(checkoutSessionId);
	}, [checkoutSessionId, confirmCheckout]);

	useEffect(() => {
		const refreshOnReturn = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			actionInFlight.current = false;
			setPendingAction(null);
			refreshSettings();
		};
		window.addEventListener("pageshow", refreshOnReturn);
		return () => window.removeEventListener("pageshow", refreshOnReturn);
	}, [refreshSettings]);

	const openPortal = (purpose: "sso" | "domain_verification" = "sso") => {
		const requestedDomain = settings.domains.length ? undefined : domain.trim();
		if (requestedDomain && /[@/:\s]/.test(requestedDomain)) {
			setError("Enter a domain such as company.com, without an email or URL.");
			return;
		}
		runAction("portal", async () => {
			const { url } = await openOrganizationSsoPortal(
				organizationId,
				requestedDomain || undefined,
				purpose,
			);
			window.location.assign(url);
		});
	};

	const openBilling = () => {
		runAction("billing", async () => {
			const { url } = await manageOrganizationSsoBilling(organizationId);
			window.location.assign(url);
		});
	};

	return (
		<Card>
			<div className="flex flex-wrap gap-4 justify-between items-start">
				<div className="flex gap-3 items-start">
					<div className="flex justify-center items-center rounded-xl bg-gray-3 size-10 shrink-0">
						<ShieldCheck className="size-5 text-gray-11" aria-hidden="true" />
					</div>
					<CardHeader>
						<CardTitle>SAML SSO</CardTitle>
						<CardDescription className="max-w-xl">
							Let your team sign in to Cap with your organization's identity
							provider, including Okta, Microsoft Entra ID, and Google
							Workspace.
						</CardDescription>
					</CardHeader>
				</div>
				<span
					className={`rounded-full px-2.5 py-1 text-xs font-medium ${
						isActive ? "bg-green-50 text-green-700" : "bg-gray-3 text-gray-11"
					}`}
				>
					{statusLabel}
				</span>
			</div>

			<div className="flex flex-col gap-4 mt-5">
				<p className="text-sm leading-6 text-gray-11">
					People who sign in with your SSO connection are automatically added to{" "}
					<span className="font-medium text-gray-12">
						{settings.organizationName}
					</span>{" "}
					as members. Cap Pro seats are billed separately from this add-on.
				</p>

				{!settings.ssoAvailable && (
					<p className="rounded-xl border border-gray-4 bg-gray-2 p-3 text-sm text-gray-11">
						SSO setup is currently unavailable. Contact{" "}
						<a className="underline" href="mailto:hello@cap.so">
							hello@cap.so
						</a>{" "}
						for help.
					</p>
				)}

				{settings.entitled ? (
					<>
						{settings.domains.length ? (
							<div className="flex flex-wrap gap-2">
								{settings.domains.map((entry) => (
									<span
										key={entry.domain}
										className="rounded-lg border border-gray-4 px-3 py-1.5 text-xs text-gray-11"
									>
										<span className="font-medium text-gray-12">
											{entry.domain}
										</span>
										{" · "}
										{entry.state === "verified"
											? "Verified"
											: "Verification needed"}
									</span>
								))}
							</div>
						) : (
							<div className="flex flex-col gap-2 max-w-sm">
								<label
									htmlFor={domainInputId}
									className="text-sm font-medium text-gray-12"
								>
									Organization domain
								</label>
								<Input
									id={domainInputId}
									value={domain}
									onChange={(event) => setDomain(event.target.value)}
									placeholder="company.com"
									autoCapitalize="none"
									autoCorrect="off"
									disabled={busy || !settings.ssoAvailable}
								/>
							</div>
						)}
						<p className="text-xs leading-5 text-gray-10">
							{hasVerifiedDomain
								? "Your IT administrator completes SAML configuration in WorkOS. Return here to check the connection status."
								: "First, verify your organization's domain in WorkOS. Then return here to set up the SAML connection."}
						</p>
						{settings.connection && (
							<p className="text-sm text-gray-11">
								{settings.connection.name}
								{" · "}
								{isActive ? "Ready for sign-in" : "Setup not complete"}
							</p>
						)}
						{settings.connectionIssue && (
							<output className="text-sm text-gray-11">
								{settings.connectionIssue}
							</output>
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant="dark"
								onClick={() => openPortal()}
								disabled={busy || !settings.ssoAvailable}
								spinner={pendingAction === "portal"}
							>
								{!hasVerifiedDomain
									? "Verify domain"
									: settings.connection || settings.connectionIssue
										? "Manage SSO"
										: "Set up SAML SSO"}
								<ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
							</Button>
							{hasVerifiedDomain &&
								settings.domains.some(
									(entry) => entry.state !== "verified",
								) && (
									<Button
										type="button"
										size="sm"
										variant="gray"
										onClick={() => openPortal("domain_verification")}
										disabled={busy || !settings.ssoAvailable}
									>
										Verify domains
									</Button>
								)}
							{settings.canManageBilling && settings.hasSubscription && (
								<Button
									type="button"
									size="sm"
									variant="gray"
									onClick={openBilling}
									disabled={busy}
									spinner={pendingAction === "billing"}
								>
									Manage subscription
								</Button>
							)}
						</div>
						{settings.cancelAtPeriodEnd && (
							<p className="text-sm text-gray-11">
								Your SSO add-on is scheduled to end {periodEndLabel}. Manage
								your subscription to keep it active.
							</p>
						)}
					</>
				) : settings.canManageBilling ? (
					<div className="flex flex-col gap-3">
						{hasExistingSubscription ? (
							<>
								<p className="text-sm text-gray-11">
									Your SSO subscription needs attention before setup is
									available. Manage the existing subscription to review its
									payment status.
								</p>
								<Button
									type="button"
									size="sm"
									variant="dark"
									className="w-fit"
									onClick={openBilling}
									disabled={busy}
									spinner={pendingAction === "billing"}
								>
									Manage SSO subscription
								</Button>
							</>
						) : (
							<div className="flex flex-wrap gap-3 items-end">
								{price && settings.prices.length > 1 && (
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor={currencyInputId}
											className="text-xs font-medium text-gray-11"
										>
											Billing currency
										</label>
										<select
											id={currencyInputId}
											value={price.currency}
											onChange={(event) => {
												if (isSupportedCurrency(event.target.value)) {
													setSelectedCurrency(event.target.value);
												}
											}}
											disabled={busy || !settings.ssoAvailable}
											className="h-10 rounded-lg border border-gray-4 bg-gray-1 px-3 text-sm text-gray-12"
										>
											{settings.prices.map((candidate) => (
												<option
													key={candidate.currency}
													value={candidate.currency}
												>
													{candidate.currency.toUpperCase()}
												</option>
											))}
										</select>
									</div>
								)}
								<Button
									type="button"
									size="sm"
									variant="dark"
									disabled={
										busy ||
										!settings.ssoAvailable ||
										!price ||
										Boolean(checkoutSessionId)
									}
									spinner={pendingAction === "checkout"}
									onClick={() => {
										if (!price) return;
										setSelectedCurrency(price.currency);
										runAction("checkout", async () => {
											const { url } = await startOrganizationSsoCheckout(
												organizationId,
												price.currency,
											);
											window.location.assign(url);
										});
									}}
								>
									{monthlyAmount
										? `Add SAML SSO · ${monthlyAmount}/month`
										: "Pricing unavailable"}
								</Button>
							</div>
						)}
					</div>
				) : (
					<p className="text-sm text-gray-11">
						Ask your organization owner to add SAML SSO. Once subscribed, owners
						and admins can configure it here.
					</p>
				)}

				{isActive && settings.signInUrl && (
					<div className="flex flex-col gap-2 rounded-xl border border-gray-4 bg-gray-2 p-4">
						<label
							htmlFor={signInLinkInputId}
							className="text-sm font-medium text-gray-12"
						>
							Share your SSO sign-in link
						</label>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Input
								id={signInLinkInputId}
								value={settings.signInUrl}
								readOnly
								className="min-w-0 flex-1"
							/>
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(
											settings.signInUrl ?? "",
										);
										toast.success("SSO sign-in link copied");
									} catch {
										toast.error(
											"Couldn't copy the link. Select it above and copy it manually.",
										);
									}
								}}
							>
								<Copy className="mr-1 size-3.5" aria-hidden="true" />
								Copy link
							</Button>
						</div>
					</div>
				)}

				{pendingAction === "confirm" && (
					<output className="text-sm text-gray-11">
						Confirming your SSO subscription…
					</output>
				)}
				{error && (
					<p
						className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
						role="alert"
					>
						{error}
					</p>
				)}
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="w-fit"
					onClick={refreshSettings}
					disabled={busy}
					spinner={pendingAction === "refresh" || pendingAction === "confirm"}
				>
					{!busy && <RefreshCw className="mr-1 size-3.5" aria-hidden="true" />}
					Refresh status
				</Button>
			</div>
		</Card>
	);
}
