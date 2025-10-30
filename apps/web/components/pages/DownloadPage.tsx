"use client";

import { Button } from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Link from "next/link";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	getVersionText,
	PlatformIcons,
} from "@/utils/platform";

export const DownloadPage = () => {
	const { platform, isIntel } = useDetectPlatform();
	const loading = platform === null;

	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			<div className="space-y-4 text-center">
				<h1 className="text-2xl fade-in-down animate-delay-1 md:text-4xl">
					Download Cap
				</h1>
				<p className="px-4 text-sm fade-in-down text-gray-11 animate-delay-2 md:text-base md:px-0">
					The quickest way to share your screen. Pin to your dock and record in
					seconds.
				</p>
				<div className="flex flex-col justify-center items-center space-y-4 fade-in-up animate-delay-2">
					<div className="flex flex-col items-center space-y-4">
						<Button
							variant="blue"
							size="lg"
							href={getDownloadUrl(platform, isIntel)}
							className="flex justify-center items-center py-6 font-medium text-white"
						>
							{!loading && getPlatformIcon(platform)}
							{getDownloadButtonText(platform, loading, isIntel)}
						</Button>

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
					<PlatformIcons />
				</div>

				<div className="pb-4 mt-6 fade-in-up animate-delay-2">
					<h3 className="mb-2 text-base font-medium text-gray-10">
						Other download options:
					</h3>
					<div className="flex flex-col gap-3 justify-center items-center md:flex-row">
						{platform !== "windows" && (
							<a
								href="/download/windows"
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Windows (Beta)
							</a>
						)}
						{platform === "macos" && isIntel && (
							<a
								href="/download/apple-silicon"
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Apple Silicon
							</a>
						)}
						{platform === "macos" && !isIntel && (
							<a
								href="/download/apple-intel"
								className="text-sm transition-all text-gray-10 hover:underline"
							>
								Apple Intel
							</a>
						)}
						{platform !== "macos" && (
							<>
								<a
									href="/download/apple-silicon"
									className="text-sm transition-all text-gray-8 hover:underline"
								>
									Apple Silicon
								</a>
								<a
									href="/download/apple-intel"
									className="text-sm transition-all text-gray-8 hover:underline"
								>
									Apple Intel
								</a>
							</>
						)}
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
