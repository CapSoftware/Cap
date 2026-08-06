"use client";

import { Button } from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Link from "next/link";
import { useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { ChromeExtensionButton } from "@/components/ChromeExtensionButton";
import {
	CAP_CHROME_EXTENSION_URL,
	CHROME_EXTENSION_BUTTON_CLASS,
} from "@/lib/chrome-extension";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	getVersionText,
	PlatformIcons,
} from "@/utils/platform";

export const DownloadPage = () => {
	const { platform, isIntel } = useDetectPlatform();
	const [copiedCliCommand, setCopiedCliCommand] = useState(false);
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
			<div className="space-y-4 text-center">
				<h1 className="text-2xl fade-in-down animate-delay-1 md:text-4xl">
					Download Cap
				</h1>
				<p className="px-4 text-sm fade-in-down text-gray-11 animate-delay-2 md:text-base md:px-0">
					The quickest way to share your screen. Pin to your dock or taskbar and
					record in seconds.
				</p>
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
					<div className="flex flex-col gap-3 justify-center items-center md:flex-row">
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
								Linux .deb
							</a>
						)}
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
