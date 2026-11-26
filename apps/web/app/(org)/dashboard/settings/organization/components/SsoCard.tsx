"use client";

import { Button, Input } from "@cap/ui";
import { useCurrency } from "hooks/useCurrency";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
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
	getOrganizationSsoInvoices,
	getOrganizationSsoSettings,
	type OrganizationSsoSettings,
	openOrganizationSsoPortal,
	startOrganizationSsoCheckout,
} from "@/actions/organization/sso";
import {
	formatAmount,
	isSupportedCurrency,
	type SupportedCurrency,
} from "@/utils/currency";
import { KeyDoodle } from "../_components/doodles";
import {
	SettingsNotice,
	SettingsRow,
	StatusChip,
} from "../_components/settings-ui";

type SsoAction = "checkout" | "portal" | "invoices" | "refresh" | "confirm";

const actionErrors: Record<SsoAction, string> = {
	checkout: "We couldn't open checkout. Please try again or contact support.",
	portal: "We couldn't open SSO setup. Please try again or contact support.",
	invoices:
		"We couldn't load SSO invoices. Please try again or contact support.",
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
	const [invoiceHistory, setInvoiceHistory] = useState<Awaited<
		ReturnType<typeof getOrganizationSsoInvoices>
	> | null>(null);
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
	let statusLabel = "Add-on";
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
					if (
						!succeeded ||
						action === "refresh" ||
						action === "confirm" ||
						action === "invoices"
					) {
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

	const needsDomain = settings.entitled && !settings.domains.length;
	const setupButton = settings.entitled ? (
		<Button
			type="button"
			size="xs"
			variant="dark"
			className="px-4"
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
	) : null;
	const canPurchase =
		!settings.entitled && settings.canManageBilling && !hasExistingSubscription;

	return (
		<SettingsRow
			anchor="sso"
			icon={<KeyDoodle />}
			title="SAML SSO"
			meta={
				<StatusChip tone={isActive ? "positive" : "neutral"}>
					{statusLabel}
				</StatusChip>
			}
			description="Let your team sign in to Cap with your organization's identity provider, including Okta, Microsoft Entra ID, and Google Workspace."
			control={
				canPurchase ? (
					<>
						{price && settings.prices.length > 1 && (
							<>
								<label htmlFor={currencyInputId} className="sr-only">
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
									className="px-3 h-8 text-xs font-medium rounded-full border shadow-xs border-gray-4 bg-gray-1 text-gray-12"
								>
									{settings.prices.map((candidate) => (
										<option key={candidate.currency} value={candidate.currency}>
											{candidate.currency.toUpperCase()}
										</option>
									))}
								</select>
							</>
						)}
						<Button
							type="button"
							size="xs"
							variant="dark"
							className="px-4"
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
					</>
				) : needsDomain ? null : (
					setupButton
				)
			}
		>
			<div className="flex flex-col gap-3 mt-4 sm:pl-[58px]">
				<p className="text-[13px] leading-5 text-gray-10">
					People who sign in with your SSO connection are automatically added to{" "}
					<span className="font-medium text-gray-12">
						{settings.organizationName}
					</span>{" "}
					as members. Cap Pro seats are billed separately from this add-on.
				</p>

				{!settings.ssoAvailable && (
					<SettingsNotice>
						SSO setup is currently unavailable. Contact{" "}
						<a className="underline" href="mailto:hello@cap.so">
							hello@cap.so
						</a>{" "}
						for help.
					</SettingsNotice>
				)}

				{settings.entitled ? (
					<>
						{settings.domains.length ? (
							<div className="flex flex-wrap gap-2">
								{settings.domains.map((entry) => (
									<span
										key={entry.domain}
										className="px-3 py-1.5 text-xs rounded-full border border-gray-4 text-gray-11"
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
							<div className="flex flex-col gap-2">
								<label
									htmlFor={domainInputId}
									className="text-[13px] font-medium text-gray-12"
								>
									Organization domain
								</label>
								<div className="flex flex-wrap gap-2 items-center">
									<Input
										id={domainInputId}
										value={domain}
										onChange={(event) => setDomain(event.target.value)}
										placeholder="company.com"
										autoCapitalize="none"
										autoCorrect="off"
										disabled={busy || !settings.ssoAvailable}
										className="flex-1 max-w-xs h-9 min-w-40"
									/>
									{setupButton}
								</div>
							</div>
						)}
						<p className="text-xs leading-5 text-gray-10">
							{hasVerifiedDomain
								? "Your IT administrator completes SAML configuration in WorkOS. Return here to check the connection status."
								: "First, verify your organization's domain in WorkOS. Then return here to set up the SAML connection."}
						</p>
						{settings.connection && (
							<p className="text-[13px] text-gray-11">
								{settings.connection.name}
								{" · "}
								{isActive ? "Ready for sign-in" : "Setup not complete"}
							</p>
						)}
						{settings.connectionIssue && (
							<output className="text-[13px] text-gray-11">
								{settings.connectionIssue}
							</output>
						)}
						{settings.cancelAtPeriodEnd && (
							<p className="text-[13px] text-gray-11">
								Your SSO add-on is scheduled to end {periodEndLabel}.
							</p>
						)}
					</>
				) : settings.canManageBilling ? (
					hasExistingSubscription && (
						<p className="text-[13px] leading-5 text-gray-11">
							Your SSO subscription needs attention before setup is available.
							Contact{" "}
							<a className="underline" href="mailto:hello@cap.so">
								hello@cap.so
							</a>{" "}
							for help with the existing subscription; you don't need to
							purchase it again.
						</p>
					)
				) : (
					<p className="text-[13px] leading-5 text-gray-11">
						Ask your organization owner to add SAML SSO. Once subscribed, owners
						and admins can configure it here.
					</p>
				)}

				{isActive && settings.signInUrl && (
					<div className="flex flex-col gap-2">
						<label
							htmlFor={signInLinkInputId}
							className="text-[13px] font-medium text-gray-12"
						>
							Share your SSO sign-in link
						</label>
						<div className="flex flex-wrap gap-2 items-center">
							<Input
								id={signInLinkInputId}
								value={settings.signInUrl}
								readOnly
								className="flex-1 h-9 min-w-40"
							/>
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="px-4"
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
					<output className="text-[13px] text-gray-11">
						Confirming your SSO subscription…
					</output>
				)}
				{error && (
					<SettingsNotice tone="danger" role="alert">
						{error}
					</SettingsNotice>
				)}

				<div className="flex flex-wrap gap-2">
					{settings.entitled &&
						hasVerifiedDomain &&
						settings.domains.some((entry) => entry.state !== "verified") && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="px-4"
								onClick={() => openPortal("domain_verification")}
								disabled={busy || !settings.ssoAvailable}
							>
								Verify domains
							</Button>
						)}
					{settings.canManageBilling && settings.hasSubscription && (
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="px-4"
							disabled={busy}
							spinner={pendingAction === "invoices"}
							onClick={() => {
								setInvoiceHistory(null);
								runAction("invoices", async () => {
									setInvoiceHistory(
										await getOrganizationSsoInvoices(organizationId),
									);
								});
							}}
						>
							View invoices
						</Button>
					)}
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="px-4"
						onClick={refreshSettings}
						disabled={busy}
						spinner={pendingAction === "refresh" || pendingAction === "confirm"}
					>
						{!busy && (
							<RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
						)}
						Refresh status
					</Button>
				</div>

				{invoiceHistory && (
					<div className="p-4 rounded-xl border border-gray-3 bg-gray-2">
						<h3 className="text-[13px] font-medium text-gray-12">
							SSO invoices
						</h3>
						{invoiceHistory.invoices.length ? (
							<ul className="flex flex-col gap-3 mt-3">
								{invoiceHistory.invoices.map((invoice) => (
									<li
										key={invoice.id}
										className="flex flex-wrap gap-2 justify-between items-center text-[13px]"
									>
										<span className="text-gray-11">
											{invoice.number ?? invoice.id}
											{" · "}
											{new Date(invoice.created * 1000).toLocaleDateString(
												"en-GB",
												{ timeZone: "UTC" },
											)}
										</span>
										{invoice.pdfUrl ? (
											<a
												href={invoice.pdfUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="font-medium underline text-gray-12"
											>
												Download PDF
												<span className="sr-only">
													{" "}
													for invoice {invoice.number ?? invoice.id}
												</span>
											</a>
										) : (
											<span className="text-gray-10">
												PDF not available yet
											</span>
										)}
									</li>
								))}
							</ul>
						) : (
							<p className="mt-2 text-[13px] text-gray-11">
								No SSO invoices found.
							</p>
						)}
						{invoiceHistory.hasMore && (
							<p className="mt-3 text-[13px] text-gray-11">
								Showing the latest 100 invoices. Contact{" "}
								<a href="mailto:hello@cap.so" className="underline">
									hello@cap.so
								</a>{" "}
								for older invoices.
							</p>
						)}
					</div>
				)}
			</div>
		</SettingsRow>
	);
}
