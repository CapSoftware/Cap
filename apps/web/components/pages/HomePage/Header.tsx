// million-ignore
"use client";

import { Button } from "@cap/ui";
import { faArrowRight, faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { useIsChromium } from "hooks/useIsChromium";
import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useState, useTransition } from "react";
import { sendDownloadLink } from "@/actions/send-download-link";
import { ChromeExtensionButton } from "@/components/ChromeExtensionButton";
import { LoomMark } from "@/components/icons/LoomMark";
import { LogoMarquee } from "@/components/ui/LogoMarquee";
import {
	CAP_CHROME_EXTENSION_URL,
	CHROME_EXTENSION_BUTTON_CLASS,
} from "@/lib/chrome-extension";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	PlatformIcons,
} from "@/utils/platform";
import { homepageCopy } from "../../../data/homepage-copy";
import UpgradeToPro from "../_components/UpgradeToPro";
import { InstantIcon, ScreenshotIcon, StudioIcon } from "./modeIcons";
import VideoModal from "./VideoModal";

const HERO_MODE_ICONS = {
	instant: InstantIcon,
	studio: StudioIcon,
	screenshot: ScreenshotIcon,
} as const;

const MODE_CYCLE_INTERVAL = 3500;

const HERO_MODE_COLORS = {
	instant: "text-amber-600",
	studio: "text-blue-11",
	screenshot: "text-violet-600",
} as const;

const TITLE_LEADING = "leading-[2.25rem] md:leading-[3.5rem]";

const trackHomepageEvent = (
	eventName: string,
	properties?: Record<string, unknown>,
) => {
	void import("@/app/utils/analytics").then(({ trackEvent }) => {
		trackEvent(eventName, properties);
	});
};

const HeroTitle = ({ text, animate }: { text: string; animate: boolean }) => {
	let letterIndex = -1;
	const wordCounts: Record<string, number> = {};
	const charCounts: Record<string, number> = {};

	return (
		<>
			{text.split(" ").map((word) => {
				wordCounts[word] = (wordCounts[word] ?? 0) + 1;
				return (
					<Fragment key={`${word}:${wordCounts[word]}`}>
						{" "}
						<span
							className={clsx("inline-block whitespace-nowrap", TITLE_LEADING)}
						>
							{animate
								? Array.from(word).map((char) => {
										letterIndex += 1;
										charCounts[char] = (charCounts[char] ?? 0) + 1;
										return (
											<motion.span
												key={`${char}:${charCounts[char]}`}
												className={clsx("inline-block", TITLE_LEADING)}
												initial={{
													opacity: 0,
													y: "0.4em",
													filter: "blur(6px)",
												}}
												animate={{
													opacity: 1,
													y: "0em",
													filter: "blur(0px)",
												}}
												transition={{
													duration: 0.34,
													delay: letterIndex * 0.028,
													ease: "easeOut",
												}}
											>
												{char}
											</motion.span>
										);
									})
								: word}
						</span>
					</Fragment>
				);
			})}
		</>
	);
};

interface HeaderProps {
	serverHomepageCopyVariant?: string;
}

const Header = ({ serverHomepageCopyVariant = "" }: HeaderProps) => {
	const [videoToggled, setVideoToggled] = useState(false);
	const { platform, isIntel } = useDetectPlatform();
	const isChromium = useIsChromium();
	// Render the button at its final size on first paint to avoid a layout shift
	// once the platform resolves: the label is "Download for free" for every
	// platform and the icon is always the same size, so defaulting the display to
	// macOS (also the default download target) keeps width stable.
	const displayPlatform = platform ?? "macos";
	const [email, setEmail] = useState("");
	const [emailStatus, setEmailStatus] = useState<
		"idle" | "sending" | "sent" | "error"
	>("idle");
	const [emailError, setEmailError] = useState("");
	const [isPending, startTransition] = useTransition();
	const primaryDownloadUrl =
		platform === "windows" ? "/download" : getDownloadUrl(platform, isIntel);

	const handleEmailSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setEmailStatus("sending");
		setEmailError("");
		trackHomepageEvent("download_cta_clicked", {
			source_page: "home_header",
			cta_location: "mobile_email_link",
			target: "email_download_link",
			target_url: "/download",
			detected_platform: platform ?? "unknown",
			is_intel: Boolean(isIntel),
		});

		startTransition(async () => {
			const result = await sendDownloadLink(email);
			if (result.success) {
				setEmailStatus("sent");
				if (typeof window !== "undefined" && window.bento) {
					window.bento.identify(email);
				}
			} else {
				setEmailStatus("error");
				setEmailError(result.error ?? "Something went wrong.");
			}
		});
	};

	const getHeaderContent = () => {
		const variant =
			serverHomepageCopyVariant as keyof typeof homepageCopy.header.variants;
		return (
			homepageCopy.header.variants[variant] ||
			homepageCopy.header.variants.default
		);
	};

	const headerContent = getHeaderContent();

	const heroModes = homepageCopy.header.modes;
	const [activeModeIndex, setActiveModeIndex] = useState(0);
	const [modePickerInteracted, setModePickerInteracted] = useState(false);
	const [hasCycled, setHasCycled] = useState(false);
	const activeMode = heroModes[activeModeIndex];

	useEffect(() => {
		if (modePickerInteracted) return;

		const interval = setInterval(() => {
			setActiveModeIndex((prev) => (prev + 1) % heroModes.length);
			setHasCycled(true);
		}, MODE_CYCLE_INTERVAL);

		return () => clearInterval(interval);
	}, [modePickerInteracted, heroModes.length]);

	const downloadButton = (
		<Button
			variant="dark"
			href={primaryDownloadUrl}
			onClick={() =>
				trackHomepageEvent("download_cta_clicked", {
					source_page: "home_header",
					cta_location: "primary",
					target_url: primaryDownloadUrl,
					detected_platform: platform ?? "unknown",
					is_intel: Boolean(isIntel),
				})
			}
			size="lg"
			className="flex justify-center items-center font-medium max-w-fit"
		>
			{getPlatformIcon(displayPlatform)}
			{getDownloadButtonText(displayPlatform, false, isIntel)}
		</Button>
	);

	const upgradeButton = (
		<UpgradeToPro
			text={homepageCopy.header.cta.primaryButton}
			onClick={() =>
				trackHomepageEvent("pricing_cta_clicked", {
					source_page: "home_header",
					cta_location: "secondary",
					target_url: "/pricing",
				})
			}
		/>
	);

	return (
		<div className="mt-[90px] mb-[60px] sm:mb-[100px] md:mb-[160px] w-full max-w-[1920px] overflow-x-hidden md:overflow-visible mx-auto md:mt-[140px] xl:min-h-[700px]">
			<div className="flex flex-col justify-center lg:justify-start xl:flex-row relative z-10 px-5 w-full mb-0">
				<div className="w-full max-w-2xl xl:max-w-[530px] 2xl:mt-12 mx-auto xl:ml-[100px] 2xl:ml-[150px]">
					<div className="flex flex-col text-center md:text-left w-full max-w-[650px]">
						<div className="flex justify-center mb-5 md:justify-start">
							<div className="inline-flex gap-1 p-1 rounded-full border border-gray-4 bg-gray-2">
								{heroModes.map((mode, index) => {
									const isActive = index === activeModeIndex;
									const Icon = HERO_MODE_ICONS[mode.id];
									return (
										<button
											key={mode.id}
											type="button"
											onClick={() => {
												setModePickerInteracted(true);
												setActiveModeIndex(index);
												setHasCycled(true);
											}}
											className="flex relative gap-1.5 items-center px-3 py-1.5 text-sm font-medium rounded-full cursor-pointer"
										>
											{isActive && (
												<motion.span
													layoutId="heroModeHighlight"
													className="absolute inset-0 rounded-full border shadow-sm bg-gray-1 border-gray-5"
													transition={{
														type: "spring",
														stiffness: 400,
														damping: 32,
													}}
												/>
											)}
											<Icon
												className={clsx(
													"relative z-[1] size-3.5 transition-colors",
													isActive ? HERO_MODE_COLORS[mode.id] : "text-gray-9",
												)}
											/>
											<span
												className={clsx(
													"relative z-[1] whitespace-nowrap transition-colors",
													isActive ? "text-gray-12" : "text-gray-10",
												)}
											>
												{mode.label}
												<span className="hidden sm:inline"> Mode</span>
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="mb-2 h-6">
							<AnimatePresence mode="wait" initial={false}>
								<motion.span
									key={activeMode?.id ?? activeModeIndex}
									className={clsx(
										"block text-sm font-semibold italic",
										activeMode
											? HERO_MODE_COLORS[activeMode.id]
											: "text-gray-10",
									)}
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -6 }}
									transition={{ duration: 0.25, ease: "easeOut" }}
								>
									with {activeMode?.label ?? "Instant"} Mode...
								</motion.span>
							</AnimatePresence>
						</div>

						<h1 className="relative z-10 mb-6 flex h-[4.5rem] flex-col justify-center text-[2.25rem] font-medium leading-[2.25rem] text-black md:h-[7rem] md:text-[3.75rem] md:leading-[3.5rem]">
							<AnimatePresence mode="wait" initial={false}>
								<motion.span
									key={activeMode?.id ?? activeModeIndex}
									className={clsx("block text-balance", TITLE_LEADING)}
									exit={{
										opacity: 0,
										y: -16,
										filter: "blur(4px)",
										transition: { duration: 0.2, ease: "easeIn" },
									}}
								>
									<HeroTitle
										text={activeMode?.title ?? headerContent.title}
										animate={hasCycled}
									/>
								</motion.span>
							</AnimatePresence>
						</h1>

						<p className="mx-auto mb-4 max-w-3xl text-lg leading-7 text-zinc-500 md:mx-0">
							{headerContent.description}
						</p>
					</div>

					{isChromium ? (
						<div className="hidden md:flex flex-col gap-4 mb-5">
							<div className="flex flex-wrap gap-4 items-center">
								{downloadButton}
								<span className="text-sm font-medium text-gray-500">or</span>
								<ChromeExtensionButton
									variant="white"
									onClick={() =>
										trackHomepageEvent("download_cta_clicked", {
											source_page: "home_header",
											cta_location: "chrome_extension_secondary",
											target: "chrome_extension",
											target_url: CAP_CHROME_EXTENSION_URL,
											detected_platform: platform ?? "unknown",
											is_intel: Boolean(isIntel),
										})
									}
									className={clsx(
										CHROME_EXTENSION_BUTTON_CLASS,
										"font-medium max-w-fit",
									)}
								/>
							</div>
							<div className="flex gap-2 items-center">
								{upgradeButton}
								<span className="max-w-[240px] text-sm leading-snug text-gray-10">
									Cap Pro gives you unlimited cloud sharing, AI summaries &amp;
									team features
								</span>
							</div>
						</div>
					) : (
						<div className="hidden md:flex flex-wrap gap-4 items-center mb-5">
							{downloadButton}
							{upgradeButton}
						</div>
					)}

					<div className="flex md:hidden flex-col gap-3 mb-5">
						{emailStatus === "sent" ? (
							<div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3">
								<p className="text-sm font-medium text-green-800">
									Check your inbox! We've sent the download links to{" "}
									<strong>{email}</strong>.
								</p>
							</div>
						) : (
							<form
								onSubmit={handleEmailSubmit}
								className="flex flex-col gap-2"
							>
								<input
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder="you@email.com"
									required
									className="w-full rounded-full border border-gray-300 bg-white px-4 py-2.5 text-sm text-black placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
								/>
								<button
									type="submit"
									disabled={isPending}
									className="w-full rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-60"
								>
									{isPending ? "Sending..." : "Email me the download link"}
								</button>
								{emailStatus === "error" && (
									<p className="text-xs text-red-600">{emailError}</p>
								)}
							</form>
						)}
						<div className="flex flex-col gap-2 items-center mt-1">
							<UpgradeToPro
								text={homepageCopy.header.cta.primaryButton}
								onClick={() =>
									trackHomepageEvent("pricing_cta_clicked", {
										source_page: "home_header",
										cta_location: "mobile_secondary",
										target_url: "/pricing",
									})
								}
							/>
							<span className="text-xs text-center text-gray-10">
								Cap Pro gives you unlimited cloud sharing, AI summaries &amp;
								team features
							</span>
						</div>
					</div>

					<div className="flex justify-center mb-3 md:justify-start">
						<Link
							href="/migrate-from-loom"
							className="inline-flex gap-2 items-center text-sm font-medium transition-colors group text-gray-11 hover:text-gray-12"
						>
							<LoomMark size={15} />
							Coming from Loom? Bring your library with you
							<FontAwesomeIcon
								icon={faArrowRight}
								className="size-3 text-gray-9 transition-transform group-hover:translate-x-0.5"
							/>
						</Link>
					</div>

					<p className="text-sm text-gray-10 text-center md:text-left">
						{homepageCopy.header.cta.freeVersionText}
					</p>

					<div className="hidden md:block mt-6 mb-10">
						<PlatformIcons source="home_header" />

						<Link
							href="/download"
							onClick={() =>
								trackHomepageEvent("download_cta_clicked", {
									source_page: "home_header",
									cta_location: "see_other_options",
									target_url: "/download",
									detected_platform: platform ?? "unknown",
									is_intel: Boolean(isIntel),
								})
							}
							className="mt-2 text-sm underline text-gray-10 hover:text-gray-12"
						>
							{homepageCopy.header.cta.seeOtherOptionsText}
						</Link>
					</div>

					<div className="mt-14">
						<p className="mb-4 text-sm italic text-gray-10 text-center md:text-left">
							Trusted by <strong>40,000+</strong> teams, builders and creators
						</p>
						<LogoMarquee />
					</div>
				</div>

				<div className="xl:absolute drop-shadow-2xl -top-[22%] lg:-right-[400px] 2xl:-right-[300px] w-full xl:max-w-[1000px] 2xl:max-w-[1200px]">
					{/* Play Button*/}
					<motion.div
						whileTap={{ scale: 0.95 }}
						whileHover={{ scale: 1.05 }}
						onClick={() => setVideoToggled(true)}
						className="size-[100px] md:size-[150px] inset-x-0 mx-auto top-[35vw] xs:top-[180px] sm:top-[35vw] xl:top-[350px] 2xl:top-[400px] xl:left-[-120px] relative cursor-pointer z-10 
              shadow-[0px_60px_40px_3px_rgba(0,0,0,0.4)] flex items-center justify-center rounded-full bg-blue-500"
					>
						<FontAwesomeIcon
							icon={faPlay}
							className="text-white size-8 md:size-12"
						/>
					</motion.div>
					<Image
						src="/illustrations/app.webp"
						width={1000}
						height={1000}
						quality={75}
						priority
						sizes="(min-width: 1536px) 1200px, (min-width: 1280px) 1000px, 100vw"
						alt="App"
						className="object-cover relative inset-0 rounded-xl opacity-70 size-full"
					/>
				</div>
			</div>
			<AnimatePresence>
				{videoToggled && <VideoModal setVideoToggled={setVideoToggled} />}
			</AnimatePresence>
		</div>
	);
};

export default Header;
