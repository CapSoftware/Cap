"use client";

import clsx from "clsx";
import { useCapChromeExtension } from "hooks/useCapChromeExtension";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ArrowRight, Check, Copy, Download, Puzzle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";
import { getDownloadUrl } from "@/utils/platform";
import { Explainer } from "./paper";
import { BackLink, StepLede, StepPage, StepTitle } from "./StepChrome";
import { RecordScene } from "./scenes";
import { useGetStarted } from "./use-get-started";

const isMobileDevice = () => {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent;
	return (
		/iPhone|iPad|iPod|Android/i.test(ua) ||
		(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
	);
};

const platformName = (platform: string | null) =>
	platform === "windows" ? "Windows" : platform === "linux" ? "Linux" : "Mac";

const OptionCard = ({
	icon,
	title,
	tag,
	children,
	action,
	featured = false,
	delay,
}: {
	icon: ReactNode;
	title: string;
	tag?: string;
	children: ReactNode;
	action: ReactNode;
	featured?: boolean;
	delay: number;
}) => (
	<li
		className={clsx(
			"ob-card ob-rise grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 p-5 sm:gap-x-5 sm:p-6",
			featured && "!border-[var(--ob-ink)] !bg-[var(--ob-surface)]",
		)}
		style={{ "--d": `${delay}s` } as CSSProperties}
	>
		<span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--ob-paper-2)] sm:row-span-3 sm:self-start">
			{icon}
		</span>
		<div className="flex flex-wrap items-center gap-2">
			<h2 className="text-[18px] font-medium tracking-[-0.01em]">{title}</h2>
			{tag && (
				<span className="rounded-full bg-[var(--ob-accent-soft)] px-2.5 py-0.5 text-[12.5px] font-medium text-[var(--ob-accent)]">
					{tag}
				</span>
			)}
		</div>
		<div className="col-span-2 text-[14.5px] leading-relaxed text-[var(--ob-ink-soft)] sm:col-span-1 sm:col-start-2 sm:-mt-2">
			{children}
		</div>
		<div className="col-span-2 mt-1 sm:col-span-1 sm:col-start-2">{action}</div>
	</li>
);

const BrowserGlyph = () => (
	<svg
		viewBox="0 0 32 32"
		className="ob-boil size-7 overflow-visible"
		aria-hidden="true"
	>
		<rect x="3" y="6" width="26" height="20" rx="4" className="ob-ink" />
		<path d="M 3 11.5 L 29 11.5" className="ob-ink" />
		<circle cx="16" cy="19" r="3.4" fill="var(--ob-red)" className="ob-pulse" />
	</svg>
);

const AppGlyph = () => (
	<svg
		viewBox="0 0 32 32"
		className="ob-boil size-7 overflow-visible"
		aria-hidden="true"
	>
		<rect x="4" y="5" width="24" height="17" rx="3" className="ob-ink" />
		<path
			d="M 13 22 L 12 27 M 19 22 L 20 27 M 10 27.5 L 22 27.5"
			className="ob-ink"
		/>
		<circle cx="16" cy="13.5" r="4" fill="var(--ob-accent)" />
		<circle cx="16" cy="13.5" r="1.9" fill="#fff" />
	</svg>
);

export const RecordStep = ({
	isPro,
	email,
	completed,
}: {
	isPro: boolean;
	email: string;
	completed: boolean;
}) => {
	const router = useRouter();
	const { complete } = useGetStarted(completed, "record");
	const { platform, isIntel } = useDetectPlatform();
	const { isChromeBrowser, isInstalled, openRecorder } =
		useCapChromeExtension();
	const [mobile, setMobile] = useState(false);
	const [downloaded, setDownloaded] = useState(false);
	const [copied, setCopied] = useState(false);
	const [leaving, setLeaving] = useState(false);

	useEffect(() => {
		setMobile(isMobileDevice());
		router.prefetch("/dashboard/caps/record");
	}, [router]);

	const leaveTo = async (href: string) => {
		setLeaving(true);
		try {
			await complete("record");
			router.push(href);
		} catch {
			setLeaving(false);
			toast.error("Something went wrong. Please try again.");
		}
	};

	const copyDownloadLink = async () => {
		try {
			await navigator.clipboard.writeText(`${window.location.origin}/download`);
			setCopied(true);
			trackEvent("onboarding_download_link_copied");
		} catch {
			toast.error(
				"Couldn't copy the link. Visit cap.so/download on your computer.",
			);
		}
	};

	const showExtension = !mobile && (isChromeBrowser || isInstalled);
	const os = platformName(platform);

	return (
		<StepPage>
			<BackLink />
			<div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
				<div className="flex min-w-0 flex-col">
					<StepTitle>Record your first Cap</StepTitle>
					<StepLede>
						Show it instead of typing it out. Pick how you'd like to record and
						you'll have a link to share as soon as you stop.
					</StepLede>

					<ul className="mt-8 flex flex-col gap-3.5">
						<OptionCard
							featured
							delay={0.1}
							icon={<BrowserGlyph />}
							title="Record in your browser"
							tag="Fastest"
							action={
								<button
									type="button"
									className="ob-cta w-full sm:w-fit"
									disabled={leaving}
									onClick={() => {
										trackEvent("onboarding_record_selected", {
											via: "browser",
										});
										leaveTo("/dashboard/caps/record?recorder=browser");
									}}
								>
									Open the recorder
									<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
								</button>
							}
						>
							{mobile
								? "Nothing to install. Record yourself with your camera, right here."
								: "Nothing to install. Share your screen, turn on your camera and talk it through."}
							{!isPro && " Free recordings can be up to 5 minutes."}
						</OptionCard>

						<OptionCard
							delay={0.16}
							icon={<AppGlyph />}
							title="Get the Cap app"
							action={
								mobile ? (
									<button
										type="button"
										className="ob-cta is-quiet w-full sm:w-fit"
										onClick={copyDownloadLink}
									>
										{copied ? (
											<Check className="size-4" aria-hidden />
										) : (
											<Copy className="size-4" aria-hidden />
										)}
										{copied ? "Link copied" : "Copy the download link"}
									</button>
								) : downloaded ? (
									<div className="flex flex-col gap-4">
										<ol className="flex flex-col gap-2 text-[14px] text-[var(--ob-ink-2)]">
											{[
												"Open the file you just downloaded and install Cap",
												`Sign in with ${email}`,
												"Press record, and your link is ready when you stop",
											].map((line, index) => (
												<li key={line} className="flex items-start gap-2.5">
													<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--ob-track-strong)] text-[11.5px] font-medium tabular-nums">
														{index + 1}
													</span>
													<span className="min-w-0 break-words">{line}</span>
												</li>
											))}
										</ol>
										<button
											type="button"
											className="ob-cta is-quiet w-full sm:w-fit"
											disabled={leaving}
											onClick={() => leaveTo("/dashboard/caps")}
										>
											Continue to my Caps
										</button>
									</div>
								) : (
									<a
										href={getDownloadUrl(platform, isIntel)}
										className="ob-cta is-outline w-full sm:w-fit"
										onClick={() => {
											setDownloaded(true);
											trackEvent("onboarding_record_selected", {
												via: "desktop",
												platform,
											});
											complete("record").catch(() => undefined);
										}}
									>
										<Download className="size-4" aria-hidden />
										Download for {os}
									</a>
								)
							}
						>
							{mobile
								? "Studio-quality recordings and editing for Mac and Windows. Grab it on your computer."
								: `Studio-quality recordings, local editing and 4K exports for ${os}.`}
						</OptionCard>

						{showExtension && (
							<OptionCard
								delay={0.22}
								icon={
									<Puzzle className="size-6 text-[var(--ob-ink)]" aria-hidden />
								}
								title="Use the Chrome extension"
								action={
									isInstalled ? (
										<button
											type="button"
											className="ob-cta is-quiet w-full sm:w-fit"
											onClick={() => {
												trackEvent("onboarding_record_selected", {
													via: "extension",
												});
												complete("record").catch(() => undefined);
												openRecorder();
											}}
										>
											Record with Chrome
										</button>
									) : (
										<a
											href={CAP_CHROME_EXTENSION_URL}
											target="_blank"
											rel="noreferrer"
											className="ob-cta is-quiet w-full sm:w-fit"
											onClick={() => {
												trackEvent("onboarding_record_selected", {
													via: "extension_install",
												});
												complete("record").catch(() => undefined);
											}}
										>
											Add to Chrome
										</a>
									)
								}
							>
								Record any tab from your toolbar without leaving what you're
								doing.
							</OptionCard>
						)}
					</ul>
				</div>

				<Explainer
					className="ob-rise lg:sticky lg:top-8"
					label="How recording works"
					loopSeconds={9}
					scene={<RecordScene />}
					steps={[
						{
							title: "Choose what to record",
							body: "Your whole screen, a window or a tab, plus your camera and mic.",
						},
						{
							title: "Hit record and talk it through",
							body: "Pause or start over whenever you like.",
						},
						{
							title: "Stop, and your link is ready",
							body: "It uploads while you record, so there's nothing to wait for.",
						},
					]}
				/>
			</div>
		</StepPage>
	);
};
