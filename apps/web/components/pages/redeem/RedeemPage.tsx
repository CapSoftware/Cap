"use client";

import { classNames } from "@cap/utils/helpers";
import { Check, Copy, Download } from "lucide-react";
import Link from "next/link";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { trackEvent } from "@/app/utils/analytics";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { HeroSky } from "@/components/pages/HomeTwo/HeroSky";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	CREAM,
	grainBg,
	H_HERO,
	MONO,
	SHELL,
} from "@/components/pages/HomeTwo/theme";
import {
	claimGift,
	extractLicenseKey,
	giftLink,
	groupLicenseKey,
	isLicenseKey,
	LICENSE_KEY_SLOTS,
	type LicenseDuration,
	lookupGift,
	lookupPurchase,
	type PurchasedLicense,
	REDEEM_INTENT_STORAGE_KEY,
	type RedeemIntent,
	readRedeemIntent,
	redeemIntentFromLocation,
	retryAfterText,
} from "@/lib/license-redeem";
import { LicenseCard } from "./LicenseCard";

type View =
	| { kind: "enter"; error?: string }
	| { kind: "opening" }
	| { kind: "claimable"; licenseKey: string; duration: LicenseDuration }
	| {
			kind: "claimed";
			licenseKey: string;
			duration: LicenseDuration;
			email: string;
			emailSent: boolean;
	  }
	| { kind: "redeemed" }
	| { kind: "ordering" }
	| { kind: "order-slow" }
	| {
			kind: "bought";
			duration: LicenseDuration;
			email: string | null;
			licenses: PurchasedLicense[];
	  }
	| {
			kind: "gifted";
			duration: LicenseDuration;
			email: string | null;
			licenses: PurchasedLicense[];
	  };

const PURCHASE_POLL_DELAYS_MS = [0, 1200, 1800, 2500, 3500, 5000, 7000, 9000];

const CONFETTI_COLORS = ["#8FDCBB", "#8FC1F7", "#F5BE85", "#B9A5F2", "#FFFFFF"];

const FIELD =
	"h-[52px] w-full rounded-[12px] border border-[#D3DCE6] bg-white px-4 text-[16px] text-[#111111] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-[rgba(17,17,17,0.38)] hover:border-[#BCC8D6] focus:border-[#111111] focus:shadow-[0_0_0_3px_rgba(17,17,17,0.08)] disabled:opacity-60";

const NOTE = "text-[13.5px] leading-[1.5] text-[rgba(17,17,17,0.55)]";

const refusedMessage = (
	result: { status: "rate_limited"; retryAfter: number } | { status: string },
) =>
	"retryAfter" in result
		? `Too many attempts from this network. Try again in ${retryAfterText(result.retryAfter)}.`
		: "We couldn't reach the license server. Check your connection and try again.";

const storedIntent = () => {
	try {
		return window.sessionStorage.getItem(REDEEM_INTENT_STORAGE_KEY);
	} catch {
		return null;
	}
};

const rememberIntent = (intent: RedeemIntent) => {
	(window as Window & { __capRedeemIntent?: unknown }).__capRedeemIntent =
		intent;
	try {
		window.sessionStorage.setItem(
			REDEEM_INTENT_STORAGE_KEY,
			JSON.stringify(intent),
		);
	} catch {}
};

const stripIntentFromUrl = () => {
	if (!window.location.hash && !window.location.search) return;
	window.history.replaceState(
		window.history.state,
		"",
		window.location.pathname,
	);
};

const forgetIntent = () => {
	delete (window as Window & { __capRedeemIntent?: unknown }).__capRedeemIntent;
	try {
		window.sessionStorage.removeItem(REDEEM_INTENT_STORAGE_KEY);
	} catch {}
};

const useCopied = () => {
	const [copied, setCopied] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const copy = useCallback(async (id: string, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		setCopied(id);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(null), 1800);
	}, []);
	return { copied, copy };
};

const CopyButton = ({
	label,
	copiedLabel = "Copied",
	active,
	onClick,
}: {
	label: string;
	copiedLabel?: string;
	active: boolean;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-[#D3DCE6] bg-white px-3 text-[13.5px] font-medium text-[#111111] transition-colors duration-200 hover:bg-[#EDF1F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2"
	>
		{active ? (
			<Check className="size-3.5 text-[#3F9974]" strokeWidth={2.5} />
		) : (
			<Copy className="size-3.5" strokeWidth={2} />
		)}
		<span aria-live="polite">{active ? copiedLabel : label}</span>
	</button>
);

const Panel = ({ children }: { children: ReactNode }) => (
	<div className="rounded-[22px] bg-white p-5 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_24px_48px_-32px_rgba(17,17,17,0.28)] sm:p-7">
		{children}
	</div>
);

const ACTIVATE_STEPS = [
	"Download Cap and open it.",
	"Go to Settings, then Plan & license.",
	"Paste your key and choose Activate License.",
];

const ActivateSteps = () => (
	<div className="mt-6 border-t border-[#E1E7EE] pt-6">
		<p className="text-[14px] font-medium text-[#111111]">
			Turn it on in the app
		</p>
		<ol className="mt-4 space-y-3">
			{ACTIVATE_STEPS.map((step, index) => (
				<li key={step} className="flex items-start gap-3">
					<span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-[#E2F6EC] text-[12px] font-medium leading-none text-[#3F9974]">
						{index + 1}
					</span>
					<span className="text-[14.5px] leading-snug text-[rgba(17,17,17,0.72)]">
						{step}
					</span>
				</li>
			))}
		</ol>
		<Link
			href="/download"
			className={classNames(BTN_PRIMARY, "mt-6 w-full gap-2")}
		>
			<Download className="relative size-4" strokeWidth={2} />
			<span className="relative">Download Cap</span>
		</Link>
	</div>
);

const KeyRow = ({
	label,
	licenseKey,
	copied,
	onCopy,
}: {
	label?: string;
	licenseKey: string;
	copied: boolean;
	onCopy: () => void;
}) => (
	<div className="flex items-center justify-between gap-3 rounded-[12px] bg-[#F4F7FA] py-3 pl-4 pr-2.5">
		<span className="min-w-0">
			{label ? (
				<span className="mb-1 block text-[12.5px] leading-none text-[rgba(17,17,17,0.5)]">
					{label}
				</span>
			) : null}
			<span
				className={classNames(
					MONO,
					"grid w-fit grid-cols-3 gap-x-[0.8em] gap-y-1 text-[13.5px] leading-none text-[#111111] sm:text-[14.5px]",
				)}
			>
				{LICENSE_KEY_SLOTS.map((slot, index) => (
					<span key={slot}>{groupLicenseKey(licenseKey)[index]}</span>
				))}
			</span>
		</span>
		<CopyButton label="Copy key" active={copied} onClick={onCopy} />
	</div>
);

const fireConfetti = async (card: HTMLElement | null) => {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const { default: confetti } = await import("canvas-confetti");
	const rect = card?.getBoundingClientRect();
	const origin = rect
		? {
				x: (rect.left + rect.width / 2) / window.innerWidth,
				y: (rect.top + rect.height / 2) / window.innerHeight,
			}
		: { x: 0.5, y: 0.4 };
	const burst = {
		origin,
		colors: CONFETTI_COLORS,
		disableForReducedMotion: true,
		scalar: 0.9,
		ticks: 170,
	};
	confetti({ ...burst, particleCount: 60, spread: 70, startVelocity: 36 });
	confetti({
		...burst,
		particleCount: 40,
		spread: 120,
		startVelocity: 24,
		decay: 0.92,
	});
};

export const RedeemPage = ({ licenseApiUrl }: { licenseApiUrl: string }) => {
	const [view, setView] = useState<View>({ kind: "enter" });
	const [order, setOrder] = useState<{
		sessionId: string;
		attempt: number;
	} | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const emailRef = useRef<HTMLInputElement | null>(null);
	const lookupRun = useRef(0);
	const keyId = useId();
	const emailId = useId();
	const errorId = useId();
	const { copied, copy } = useCopied();

	const openGift = useCallback(
		async (licenseKey: string, source: "link" | "form") => {
			lookupRun.current += 1;
			const run = lookupRun.current;
			const result = await lookupGift(licenseApiUrl, licenseKey);
			trackEvent("license_gift_lookup", { source, result: result.status });
			if (run !== lookupRun.current) return;
			if (result.status === "claimable") {
				setView({
					kind: "claimable",
					licenseKey,
					duration: result.duration,
				});
				return;
			}
			if (result.status === "redeemed") {
				setView({ kind: "redeemed" });
				return;
			}
			if (result.status === "not_found") forgetIntent();
			setView({
				kind: "enter",
				error:
					result.status === "not_found"
						? "That key doesn't match a gift. Check it and try again."
						: refusedMessage(result),
			});
		},
		[licenseApiUrl],
	);

	const begin = useCallback(
		(intent: RedeemIntent) => {
			setEmail("");
			setFormError(null);
			setBusy(false);
			if ("session" in intent) {
				lookupRun.current += 1;
				setView({ kind: "ordering" });
				setOrder((current) => ({
					sessionId: intent.session,
					attempt: (current?.attempt ?? 0) + 1,
				}));
				return;
			}
			setOrder(null);
			setKeyInput(intent.key);
			setView({ kind: "opening" });
			void openGift(intent.key, "link");
		},
		[openGift],
	);

	useEffect(() => {
		const intent = readRedeemIntent({
			handedOver: (window as Window & { __capRedeemIntent?: unknown })
				.__capRedeemIntent,
			stored: storedIntent(),
			location: window.location,
		});
		if (intent) {
			stripIntentFromUrl();
			begin(intent);
		}
		document.body.classList.remove("rd-pending");

		// Pasting another gift link while already on this page changes only the
		// fragment, so nothing reloads and the inline script never sees it.
		// Analytics reads the URL 50 ms after a change, and by then the key has
		// been stripped here.
		const takeFromUrl = () => {
			const arrived = redeemIntentFromLocation(window.location);
			if (!arrived) return;
			stripIntentFromUrl();
			rememberIntent(arrived);
			begin(arrived);
		};
		window.addEventListener("popstate", takeFromUrl);
		window.addEventListener("hashchange", takeFromUrl);
		return () => {
			window.removeEventListener("popstate", takeFromUrl);
			window.removeEventListener("hashchange", takeFromUrl);
		};
	}, [begin]);

	// Stripe redirects here the moment payment succeeds, usually a second or
	// two before its webhook has created the license, so the order is polled.
	useEffect(() => {
		if (!order) return;
		const { sessionId } = order;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const attempt = async (index: number) => {
			const result = await lookupPurchase(
				licenseApiUrl,
				sessionId,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			if (result.status === "ready") {
				trackEvent("license_purchase_ready", {
					gift: result.gift,
					quantity: result.licenses.length,
					duration: result.duration,
				});
				setView({
					kind: result.gift ? "gifted" : "bought",
					duration: result.duration,
					email: result.email,
					licenses: result.licenses,
				});
				return;
			}
			const next = PURCHASE_POLL_DELAYS_MS[index + 1];
			if (next === undefined || result.status === "rate_limited") {
				setView({ kind: "order-slow" });
				return;
			}
			timer = setTimeout(() => void attempt(index + 1), next);
		};

		setView({ kind: "ordering" });
		void attempt(0);
		return () => {
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [order, licenseApiUrl]);

	useEffect(() => {
		if (view.kind === "claimable") emailRef.current?.focus();
	}, [view.kind]);

	const submitKey = async (event: FormEvent) => {
		event.preventDefault();
		const licenseKey = extractLicenseKey(keyInput);
		if (!isLicenseKey(licenseKey)) {
			setView({
				kind: "enter",
				error: "A license key is 30 letters and numbers. Paste the whole key.",
			});
			return;
		}
		setBusy(true);
		await openGift(licenseKey, "form");
		setBusy(false);
	};

	const submitClaim = async (event: FormEvent) => {
		event.preventDefault();
		if (view.kind !== "claimable") return;
		const address = email.trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
			setFormError("Enter the email address the license should belong to.");
			return;
		}
		setBusy(true);
		setFormError(null);
		// Another gift or order opened while this claim was in flight owns the
		// page now, so this response must not replace it or clear its intent.
		const run = lookupRun.current;
		const result = await claimGift(licenseApiUrl, view.licenseKey, address);
		trackEvent("license_gift_claim", { result: result.status });
		if (run !== lookupRun.current) return;
		setBusy(false);
		if (result.status === "claimed") {
			forgetIntent();
			setView({
				kind: "claimed",
				licenseKey: view.licenseKey,
				duration: result.duration,
				email: address.toLowerCase(),
				emailSent: result.emailSent,
			});
			void fireConfetti(cardRef.current);
			return;
		}
		if (result.status === "redeemed") {
			setView({ kind: "redeemed" });
			return;
		}
		setFormError(
			result.status === "not_found"
				? "This gift is no longer available."
				: refusedMessage(result),
		);
	};

	const startOver = () => {
		setKeyInput("");
		setEmail("");
		setFormError(null);
		forgetIntent();
		setView({ kind: "enter" });
	};

	const firstKey =
		view.kind === "bought" ? (view.licenses[0]?.licenseKey ?? null) : null;
	const card = {
		wrapped:
			view.kind === "enter" ||
			view.kind === "opening" ||
			view.kind === "ordering" ||
			view.kind === "order-slow" ||
			view.kind === "gifted",
		licenseKey: view.kind === "claimed" ? view.licenseKey : firstKey,
		owner:
			view.kind === "claimed"
				? view.email
				: view.kind === "bought"
					? view.email
					: view.kind === "redeemed"
						? "Someone else"
						: null,
		duration:
			view.kind === "claimable" ||
			view.kind === "claimed" ||
			view.kind === "bought" ||
			view.kind === "gifted"
				? view.duration
				: null,
	};

	const heading = (() => {
		switch (view.kind) {
			case "enter":
				return {
					title: "Redeem your Cap license",
					body: "Got a gift link or a license key? Enter it here and Cap is yours.",
				};
			case "opening":
				return { title: "Opening your gift", body: "One moment." };
			case "claimable":
				return {
					title: "Someone gave you Cap",
					body:
						view.duration === "lifetime"
							? "A Desktop License for the Cap desktop app, yours for life. Tell us where to send it."
							: "A Desktop License for the Cap desktop app. Tell us where to send it.",
				};
			case "claimed":
				return {
					title: "It's yours",
					body: view.emailSent
						? `Your license is registered to ${view.email}, and the key is on its way to that inbox.`
						: `Your license is registered to ${view.email}. Keep the key below somewhere safe.`,
				};
			case "redeemed":
				return {
					title: "This gift has been claimed",
					body: "A gift link works once. If you claimed it, your key is in your inbox, sent by Cap Licenses.",
				};
			case "ordering":
				return {
					title: "Finishing your order",
					body: "This takes a few seconds.",
				};
			case "order-slow":
				return {
					title: "Almost there",
					body: "Your order is taking longer than usual to appear here. Your license key is also sent by email.",
				};
			case "bought":
				return {
					title:
						view.licenses.length === 1
							? "Your license is ready"
							: "Your licenses are ready",
					body: view.email
						? `We also sent ${view.licenses.length === 1 ? "the key" : "the keys"} to ${view.email}.`
						: "Keep this page open until you have saved your key.",
				};
			case "gifted":
				if (view.licenses.every((license) => license.redeemed)) {
					return view.licenses.length === 1
						? {
								title: "Your gift has been claimed",
								body: "The person you sent it to now owns the license.",
							}
						: {
								title: "Your gifts have been claimed",
								body: "Every link from this order has been used.",
							};
				}
				return {
					title:
						view.licenses.length === 1
							? "Your gift is ready to send"
							: "Your gifts are ready to send",
					body:
						view.licenses.length === 1
							? "Share the link below. Whoever opens it enters their email and the license is theirs."
							: "Each link is one license. Whoever opens one enters their email and the license is theirs.",
				};
		}
	})();

	const panel = (() => {
		switch (view.kind) {
			case "enter":
			case "opening":
				return (
					<Panel>
						<form onSubmit={submitKey} noValidate>
							<label
								htmlFor={keyId}
								className="block text-[14px] font-medium text-[#111111]"
							>
								License key
							</label>
							<input
								id={keyId}
								type="text"
								inputMode="text"
								autoComplete="off"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								value={keyInput}
								onChange={(event) => {
									setKeyInput(event.target.value);
									if (view.kind === "enter" && view.error) {
										setView({ kind: "enter" });
									}
								}}
								placeholder="Paste your key or gift link"
								disabled={busy || view.kind === "opening"}
								aria-invalid={view.kind === "enter" && Boolean(view.error)}
								aria-describedby={
									view.kind === "enter" && view.error ? errorId : undefined
								}
								className={classNames(FIELD, MONO, "mt-2.5 text-[15px]")}
							/>
							{view.kind === "enter" && view.error ? (
								<p
									id={errorId}
									role="alert"
									className="mt-2.5 text-[13.5px] leading-[1.45] text-[#B4321F]"
								>
									{view.error}
								</p>
							) : null}
							<button
								type="submit"
								disabled={busy || view.kind === "opening"}
								className={classNames(
									BTN_PRIMARY,
									"mt-5 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
								)}
							>
								<span className="relative">
									{busy || view.kind === "opening" ? "Checking..." : "Continue"}
								</span>
							</button>
						</form>
						<p className={classNames(NOTE, "mt-5")}>
							Bought Cap for yourself? There is nothing to redeem. Paste your
							key into the app under Settings, then Plan &amp; license.
						</p>
					</Panel>
				);
			case "claimable":
				return (
					<Panel>
						<form onSubmit={submitClaim} noValidate>
							<label
								htmlFor={emailId}
								className="block text-[14px] font-medium text-[#111111]"
							>
								Your email
							</label>
							<input
								ref={emailRef}
								id={emailId}
								type="email"
								inputMode="email"
								autoComplete="email"
								value={email}
								onChange={(event) => {
									setEmail(event.target.value);
									setFormError(null);
								}}
								placeholder="you@example.com"
								disabled={busy}
								aria-invalid={Boolean(formError)}
								aria-describedby={formError ? errorId : undefined}
								className={classNames(FIELD, "mt-2.5")}
							/>
							{formError ? (
								<p
									id={errorId}
									role="alert"
									className="mt-2.5 text-[13.5px] leading-[1.45] text-[#B4321F]"
								>
									{formError}
								</p>
							) : null}
							<button
								type="submit"
								disabled={busy}
								className={classNames(
									BTN_PRIMARY,
									"mt-5 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
								)}
							>
								<span className="relative">
									{busy ? "Claiming..." : "Claim license"}
								</span>
							</button>
						</form>
						<p className={classNames(NOTE, "mt-5")}>
							The license is registered to this address and the key is emailed
							there. You will use it if you ever move Cap to another device.
						</p>
					</Panel>
				);
			case "claimed":
				return (
					<Panel>
						<KeyRow
							licenseKey={view.licenseKey}
							copied={copied === "key-0"}
							onCopy={() => void copy("key-0", view.licenseKey)}
						/>
						<ActivateSteps />
					</Panel>
				);
			case "redeemed":
				return (
					<Panel>
						<p className="text-[14.5px] leading-[1.55] text-[rgba(17,17,17,0.72)]">
							Not you? Ask the person who sent the link. They can see which of
							their gifts have been claimed.
						</p>
						<button
							type="button"
							onClick={startOver}
							className={classNames(
								BTN_SECONDARY,
								"mt-5 w-full cursor-pointer",
							)}
						>
							Enter a different key
						</button>
					</Panel>
				);
			case "ordering":
				return (
					<output className={classNames(NOTE, "block text-center")}>
						Preparing your license...
					</output>
				);
			case "order-slow":
				return (
					<Panel>
						<button
							type="button"
							onClick={() =>
								setOrder(
									(current) =>
										current && { ...current, attempt: current.attempt + 1 },
								)
							}
							className={classNames(BTN_PRIMARY, "w-full cursor-pointer")}
						>
							<span className="relative">Check again</span>
						</button>
					</Panel>
				);
			case "bought":
				return (
					<Panel>
						<div className="space-y-2.5">
							{view.licenses.map((license, index) =>
								license.licenseKey ? (
									<KeyRow
										key={license.licenseKey}
										label={
											view.licenses.length > 1
												? `License ${index + 1}`
												: undefined
										}
										licenseKey={license.licenseKey}
										copied={copied === `key-${index}`}
										onCopy={() =>
											void copy(`key-${index}`, license.licenseKey ?? "")
										}
									/>
								) : null,
							)}
						</div>
						<ActivateSteps />
					</Panel>
				);
			case "gifted":
				return (
					<Panel>
						<ul className="space-y-2.5">
							{view.licenses.map((license, index) => {
								const link = license.redeemed
									? null
									: giftLink(window.location.origin, license.licenseKey);
								return (
									<li
										key={license.position}
										className="flex items-center justify-between gap-3 rounded-[12px] bg-[#F4F7FA] py-2.5 pl-4 pr-2.5"
									>
										<span className="min-w-0">
											<span
												className={classNames(
													"block leading-none",
													link
														? "mb-1.5 text-[12.5px] text-[rgba(17,17,17,0.5)]"
														: "py-2 text-[14.5px] text-[rgba(17,17,17,0.72)]",
												)}
											>
												{view.licenses.length > 1
													? `Gift ${index + 1}`
													: "Gift link"}
											</span>
											{link ? (
												<span
													className={classNames(
														MONO,
														"block truncate text-[13.5px] leading-[1.35] text-[#111111]",
													)}
												>
													{link.replace(/^https?:\/\//, "")}
												</span>
											) : null}
										</span>
										{link ? (
											<CopyButton
												label="Copy link"
												active={copied === `gift-${index}`}
												onClick={() => {
													void copy(`gift-${index}`, link);
													trackEvent("license_gift_link_copied");
												}}
											/>
										) : (
											<span className="mr-1.5 inline-flex shrink-0 items-center gap-1.5 text-[13.5px] font-medium text-[#3F9974]">
												<Check className="size-3.5" strokeWidth={2.5} />
												Claimed
											</span>
										)}
									</li>
								);
							})}
						</ul>
						{view.licenses.some((license) => !license.redeemed) ? (
							<p className={classNames(NOTE, "mt-5")}>
								{view.email
									? `We also emailed ${view.licenses.length === 1 ? "this link" : "these links"} to ${view.email}. `
									: ""}
								A link works once, and anyone who has it can claim it, so send
								it only to the person it is for.
							</p>
						) : null}
					</Panel>
				);
		}
	})();

	return (
		<div
			data-header-flat
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
				<div
					className="rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
					style={grainBg(CREAM)}
				>
					<div
						className="rounded-[24px] rounded-b-[28px]"
						style={grainBg(BAND)}
					>
						<section className="relative px-5 pb-[168px] pt-12 sm:pb-[196px] sm:pt-14 lg:pt-[60px]">
							<HeroSky className="rounded-[24px] rounded-b-[28px]" />
							<div
								data-rd-boot
								className="relative mx-auto flex min-h-[148px] max-w-[720px] flex-col items-center text-center sm:min-h-[168px]"
								aria-live="polite"
							>
								<h1
									className={`${H_HERO} text-balance text-[clamp(38px,5.4vw,68px)]`}
								>
									{heading.title}
								</h1>
								<p
									className={`${BODY_TEXT} mt-5 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18.5px]`}
								>
									{heading.body}
								</p>
								<span
									data-header-sentinel
									aria-hidden="true"
									className="pointer-events-none absolute bottom-0 left-0 size-px"
								/>
							</div>
						</section>
					</div>

					<section className="relative -mt-[132px] px-4 pb-20 sm:-mt-[156px] sm:px-5 lg:pb-28">
						<div className="mx-auto max-w-[440px]">
							<div ref={cardRef}>
								<LicenseCard {...card} />
							</div>
							<div data-rd-boot className="mt-8 sm:mt-10">
								{panel}
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
};
