"use client";

import { Button } from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Link from "next/link";
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { ChromeExtensionButton } from "@/components/ChromeExtensionButton";
import {
	CAP_CHROME_EXTENSION_URL,
	CHROME_EXTENSION_BUTTON_CLASS,
} from "@/lib/chrome-extension";
import { LAST_TAURI_VERSION } from "@/utils/native-release";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	getVersionText,
	PlatformIcons,
} from "@/utils/platform";

const BADGE_LOOP =
	"M 22 33 C 19 15, 84 7, 150 7.5 C 222 8, 289 14, 287 31 C 285 49, 214 55, 146 54 C 78 53, 12 47, 14 29 C 15.5 18, 44 10.5, 76 9";
const BADGE_SPARKS = [
	"M 3.5 11 L 4.6 4.2",
	"M 7.2 12.8 L 12.2 7.8",
	"M 9.2 16.6 L 16 15.4",
];
const UNDERLINE =
	"M 3 7.5 C 28 3.5, 57 9.5, 88 5.5 C 118 2, 146 9, 176 4.5 C 186 3.2, 193 3.8, 198 4.4";

function BoilFilter({ id }: { id: string }) {
	return (
		<svg className="absolute size-0" aria-hidden="true" focusable="false">
			<defs>
				<filter id={id} x="-10%" y="-40%" width="120%" height="180%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.045"
						numOctaves="2"
						seed="2"
						result="noise"
					>
						<animate
							attributeName="seed"
							values="2;4;6;8"
							dur="0.64s"
							repeatCount="indefinite"
							calcMode="discrete"
						/>
					</feTurbulence>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="2.2"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
			</defs>
		</svg>
	);
}

function NativeAnnouncement({ boil }: { boil: string }) {
	const ink = { "--dl-boil": `url(#${boil})` } as CSSProperties;
	return (
		<div className="inline-flex items-center gap-5 text-[13px]">
			<span className="relative inline-flex px-2 py-0.5">
				<span className="relative z-10 font-medium text-blue-11">New</span>
				<svg
					className="dl-ink pointer-events-none absolute -inset-x-2 -inset-y-1.5 h-[calc(100%+12px)] w-[calc(100%+16px)] overflow-visible text-blue-9"
					viewBox="0 0 300 60"
					preserveAspectRatio="none"
					aria-hidden="true"
					style={ink}
				>
					<path className="dl-ink-loop" pathLength={1} d={BADGE_LOOP} />
				</svg>
				<svg
					className="dl-ink pointer-events-none absolute -top-4 -right-5 size-[18px] overflow-visible text-blue-9"
					viewBox="0 0 20 20"
					aria-hidden="true"
					style={ink}
				>
					{BADGE_SPARKS.map((spark, index) => (
						<path
							key={spark}
							className="dl-ink-spark"
							pathLength={1}
							d={spark}
							style={{ animationDelay: `${1.2 + index * 0.08}s` }}
						/>
					))}
				</svg>
			</span>
			<span className="text-gray-11">
				Rebuilt native for macOS, Windows and Linux
			</span>
		</div>
	);
}

function InkUnderline({
	children,
	boil,
}: {
	children: ReactNode;
	boil: string;
}) {
	return (
		<span className="relative inline-block whitespace-nowrap text-gray-12">
			{children}
			<svg
				className="dl-ink pointer-events-none absolute -bottom-1 left-0 h-2.5 w-full overflow-visible text-blue-9"
				viewBox="0 0 200 10"
				preserveAspectRatio="none"
				aria-hidden="true"
				style={{ "--dl-boil": `url(#${boil})` } as CSSProperties}
			>
				<path className="dl-ink-underline" pathLength={1} d={UNDERLINE} />
			</svg>
		</span>
	);
}

export const DownloadPage = ({
	nativeReleaseLive = false,
}: {
	nativeReleaseLive?: boolean;
}) => {
	const { platform, isIntel } = useDetectPlatform();
	const [copiedCliCommand, setCopiedCliCommand] = useState(false);
	const boil = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const loading = platform === null;
	const primaryDownloadUrl = getDownloadUrl(platform, isIntel);
	const cliInstallCommand =
		platform === "windows"
			? "irm https://cap.so/install-cli.ps1 | iex"
			: "curl -fsSL https://cap.so/install-cli.sh | sh";

	const trackDownloadClick = (
		ctaLocation: string,
		targetUrl: string,
		target?: string,
	) => {
		trackEvent("download_cta_clicked", {
			source_page: "download_page",
			cta_location: ctaLocation,
			...(target ? { target } : {}),
			target_url: targetUrl,
			detected_platform: platform ?? "unknown",
			is_intel: Boolean(isIntel),
		});
	};

	const copyCliInstallCommand = async () => {
		await navigator.clipboard.writeText(cliInstallCommand);
		setCopiedCliCommand(true);
		trackEvent("cli_install_command_copied", {
			source_page: "download_page",
			detected_platform: platform ?? "unknown",
		});
		window.setTimeout(() => setCopiedCliCommand(false), 2000);
	};

	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			{nativeReleaseLive && <BoilFilter id={boil} />}
			<div className="space-y-4 text-center">
				{nativeReleaseLive && (
					<div className="flex justify-center items-center h-8 fade-in-down">
						<NativeAnnouncement boil={boil} />
					</div>
				)}
				<h1 className="text-2xl fade-in-down animate-delay-1 md:text-4xl">
					Download Cap
				</h1>
				{nativeReleaseLive ? (
					<p className="px-4 mx-auto max-w-xl text-sm fade-in-down text-gray-11 animate-delay-2 md:text-base md:px-0">
						The quickest way to share your screen, now a{" "}
						<InkUnderline boil={boil}>fully native app</InkUnderline>. It opens
						faster and stays light on your computer while you record.
					</p>
				) : (
					<p className="px-4 text-sm fade-in-down text-gray-11 animate-delay-2 md:text-base md:px-0">
						The quickest way to share your screen. Pin to your dock or taskbar
						and record in seconds.
					</p>
				)}
				<div className="flex flex-col justify-center items-center space-y-4 fade-in-up animate-delay-2">
					<div className="flex flex-col items-center space-y-4">
						<div className="flex flex-col gap-3 justify-center items-center w-full sm:flex-row sm:gap-4">
							<Button
								variant="blue"
								size="lg"
								href={primaryDownloadUrl}
								onClick={() =>
									trackDownloadClick("primary", primaryDownloadUrl)
								}
								className="flex justify-center items-center w-full font-medium text-white sm:w-auto"
							>
								{!loading && getPlatformIcon(platform)}
								{getDownloadButtonText(platform, loading, isIntel)}
							</Button>
							<span className="text-sm font-medium text-gray-500">or</span>
							<ChromeExtensionButton
								variant="white"
								size="lg"
								onClick={() =>
									trackDownloadClick(
										"chrome_extension_primary",
										CAP_CHROME_EXTENSION_URL,
										"chrome_extension",
									)
								}
								className={`${CHROME_EXTENSION_BUTTON_CLASS} w-full font-medium sm:w-auto`}
							/>
						</div>

						<div className="text-sm text-gray-10">
							{getVersionText(platform)}
						</div>

						{nativeReleaseLive && (
							<p className="text-xs text-gray-10">
								Looking for the original app?{" "}
								<Link
									href={`/download/versions#v${LAST_TAURI_VERSION}`}
									onClick={() =>
										trackDownloadClick(
											"last_tauri_version",
											"/download/versions",
											"tauri_app",
										)
									}
									className="underline underline-offset-2 hover:text-gray-12"
								>
									Cap {LAST_TAURI_VERSION}
								</Link>{" "}
								is still available.
							</p>
						)}

						{/* Windows SmartScreen video and instructions */}
						{platform === "windows" && (
							<div className="mt-4 max-w-md">
								<video
									src="/windows-smartscreen.mp4"
									autoPlay
									loop
									muted
									playsInline
									className="mx-auto w-full rounded-md shadow-md"
									style={{ maxWidth: "300px" }}
								/>
								<p className="mt-2 text-sm text-gray-8">
									Whilst Cap for Windows is in early beta, after downloading and
									running the app, follow the steps above to whitelist Cap on
									your PC.
								</p>
							</div>
						)}
					</div>
				</div>

				<div className="flex justify-center items-center fade-in-up animate-delay-2">
					<PlatformIcons source="download_page" />
				</div>

				<div className="mx-auto mt-6 max-w-xl fade-in-up animate-delay-2">
					<div className="rounded-xl border border-gray-5 bg-gray-2 p-4 text-left">
						<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
							<div>
								<h3 className="text-sm font-medium text-gray-12">
									Install the Cap CLI
								</h3>
								<p className="mt-1 text-xs leading-5 text-gray-10">
									Already have Cap Desktop? Link the bundled CLI for agents,
									scripts, and terminals.
								</p>
							</div>
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={copyCliInstallCommand}
								className="shrink-0"
							>
								{copiedCliCommand ? "Copied" : "Copy command"}
							</Button>
						</div>
						<code className="mt-3 block overflow-x-auto rounded-lg bg-gray-1 px-3 py-2 font-mono text-xs text-gray-12">
							{cliInstallCommand}
						</code>
					</div>
				</div>

				<div className="pb-4 mt-6 fade-in-up animate-delay-2">
					<h3 className="mb-2 text-base font-medium text-gray-10">
						Other download options:
					</h3>
					<div className="flex flex-col gap-3 justify-center items-center md:flex-row md:flex-wrap">
						{platform !== "windows" && (
							<a
								href="/download/windows"
								onClick={() =>
									trackDownloadClick(
										"other_option_windows",
										"/download/windows",
									)
								}
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Windows (Beta)
							</a>
						)}
						{platform !== "linux" && (
							<a
								href="/download/linux-deb"
								onClick={() =>
									trackDownloadClick(
										"other_option_linux_deb",
										"/download/linux-deb",
									)
								}
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Debian / Ubuntu (.deb)
							</a>
						)}
						<a
							href="/download/linux-appimage"
							onClick={() =>
								trackDownloadClick(
									"other_option_linux_appimage",
									"/download/linux-appimage",
								)
							}
							className="text-sm transition-all text-gray-10 hover:underline"
						>
							AppImage
						</a>
						<a
							href="/download/linux-rpm"
							onClick={() =>
								trackDownloadClick(
									"other_option_linux_rpm",
									"/download/linux-rpm",
								)
							}
							className="text-sm transition-all text-gray-10 hover:underline"
						>
							Fedora / RPM
						</a>
						<a
							href="/download/linux-pacman"
							onClick={() =>
								trackDownloadClick(
									"other_option_linux_pacman",
									"/download/linux-pacman",
								)
							}
							className="text-sm transition-all text-gray-10 hover:underline"
						>
							Arch / Pacman
						</a>
						{platform === "macos" && isIntel && (
							<a
								href="/download/apple-silicon"
								onClick={() =>
									trackDownloadClick(
										"other_option_apple_silicon",
										"/download/apple-silicon",
									)
								}
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Apple Silicon
							</a>
						)}
						{platform === "macos" && !isIntel && (
							<a
								href="/download/apple-intel"
								onClick={() =>
									trackDownloadClick(
										"other_option_apple_intel",
										"/download/apple-intel",
									)
								}
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Apple Intel
							</a>
						)}
						{platform !== "macos" && (
							<>
								<a
									href="/download/apple-silicon"
									onClick={() =>
										trackDownloadClick(
											"other_option_apple_silicon",
											"/download/apple-silicon",
										)
									}
									className="text-sm transition-all text-gray-8 hover:underline"
								>
									Apple Silicon
								</a>
								<a
									href="/download/apple-intel"
									onClick={() =>
										trackDownloadClick(
											"other_option_apple_intel",
											"/download/apple-intel",
										)
									}
									className="text-sm transition-all text-gray-8 hover:underline"
								>
									Apple Intel
								</a>
							</>
						)}
						<Link
							href="/download/versions"
							onClick={() =>
								trackDownloadClick("all_versions", "/download/versions")
							}
							className="text-sm transition-all text-gray-10 hover:underline"
						>
							All versions
						</Link>
					</div>
				</div>

				{/* Discreet SEO Links */}
				<div className="pt-8 mt-32 text-xs border-t border-gray-5 text-gray-12">
					<div className="flex flex-wrap gap-y-2 gap-x-4 justify-center items-center mx-auto max-w-lg">
						<Link
							href="/screen-recorder"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Screen Recorder
						</Link>
						<span className="hidden md:inline">•</span>
						<Link
							href="/free-screen-recorder"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Free Screen Recorder
						</Link>
						<span className="hidden md:inline">•</span>
						<Link
							href="/screen-recorder-mac"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Mac Screen Recorder
						</Link>
						<span className="hidden md:inline">•</span>
						<Link
							href="/mac-screen-recording-with-audio"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Mac Audio Recording
						</Link>
						<span className="hidden md:inline">•</span>
						<Link
							href="/screen-recorder-windows"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Windows Screen Recorder
						</Link>
						<span className="hidden md:inline">•</span>
						<Link
							href="/screen-recording-software"
							className="text-xs hover:text-gray-8 hover:underline"
						>
							Recording Software
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
};
