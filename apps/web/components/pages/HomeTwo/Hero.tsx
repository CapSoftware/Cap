"use client";

import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ArrowDown } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { getDownloadUrl } from "@/utils/platform";
import { CapRecorderWindow } from "./demo/CapRecorderWindow";
import { LinkNotification } from "./demo/CapSurfaces";
import { MenuBar } from "./demo/MacDesktop";
import { AppleGlyph } from "./glyphs";
import { HeroHeadline } from "./HeroHeadline";
import { Fit, noop, useInView } from "./scenes/engine";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	MODE_THEME,
	meshStyle,
} from "./theme";

const PHONE_STAGE = { w: 440, h: 508 };

const PhoneStage = () => {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(boxRef, "0px");
	return (
		<div ref={boxRef} className="mt-10 w-full md:hidden">
			<div
				className="rounded-[22px] p-2.5"
				style={meshStyle(MODE_THEME.instant)}
			>
				<Fit w={PHONE_STAGE.w} h={PHONE_STAGE.h} className="mx-auto">
					<div
						className="relative overflow-hidden rounded-[14px] bg-black"
						style={{ width: PHONE_STAGE.w, height: PHONE_STAGE.h }}
					>
						<Image
							src="/backgrounds/sf.webp"
							alt=""
							fill
							sizes="440px"
							draggable={false}
							className="object-cover"
						/>
						<MenuBar recording={false} onSwitchOs={noop} />
						<div className="absolute z-20" style={{ left: 48, top: 30 }}>
							<LinkNotification visible={inView} onOpen={noop} />
						</div>
						<div className="absolute z-10" style={{ left: 55, top: 104 }}>
							<CapRecorderWindow
								ui={{
									visible: true,
									mode: "instant",
									displaySelected: true,
									cameraOn: true,
								}}
								onMode={noop}
								onSelectDisplay={noop}
								onToggleCamera={noop}
								onMiss={noop}
							/>
						</div>
					</div>
				</Fit>
			</div>
		</div>
	);
};

const WindowsGlyph = ({ className }: { className?: string }) => (
	<svg
		aria-hidden="true"
		className={className}
		viewBox="0 0 24 24"
		fill="currentColor"
	>
		<path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623" />
	</svg>
);

const AltIcon = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) => (
	<Link
		href="/download"
		aria-label={`Download Cap: ${label}`}
		title={label}
		className="grid size-7 place-items-center rounded-[7px] text-[rgba(17,17,17,0.45)] transition-colors duration-200 hover:bg-[#E7EDF3] hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
	>
		{children}
	</Link>
);

export const Hero = () => {
	const { platform, isIntel } = useDetectPlatform();

	const displayPlatform = platform ?? "macos";
	const isWindows = displayPlatform === "windows";
	const isLinux = displayPlatform === "linux";
	const platformName = isWindows ? "Windows" : isLinux ? "Linux" : "macOS";
	const downloadHref = isWindows
		? "/download"
		: getDownloadUrl(displayPlatform, isIntel);

	return (
		<section className="relative px-5 pb-12 pt-12 sm:pt-14 md:pb-4 md:pt-[56px]">
			<span
				data-header-sentinel
				aria-hidden="true"
				className="pointer-events-none absolute bottom-0 left-0 size-px"
			/>
			<div className="mx-auto flex max-w-[1020px] flex-col items-center text-center">
				<HeroHeadline />

				<p
					className={`${BODY_TEXT} mt-8 max-w-[660px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[19px] md:mt-10`}
				>
					One open source app for every way you capture your screen. Start free
					and move to Cap Pro when you need more, whether you work alone, with a
					small team, or across an entire organization.
				</p>

				<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
					<Link
						href={downloadHref}
						onClick={() =>
							trackEvent("download_cta_clicked", {
								source_page: "home_header",
								cta_location: "primary",
								target_url: downloadHref,
								detected_platform: platform ?? "unknown",
								is_intel: Boolean(isIntel),
							})
						}
						className={BTN_PRIMARY}
					>
						{isWindows ? (
							<WindowsGlyph className="mr-2.5 size-[18px]" />
						) : isLinux ? (
							<Image
								src="/logos/os/linux.svg"
								alt=""
								width={19}
								height={19}
								className="mr-2.5 size-[19px]"
							/>
						) : (
							<AppleGlyph className="mr-2.5 size-[19px]" />
						)}
						Download free for {platformName}
					</Link>

					<button
						type="button"
						onClick={() => {
							window.dispatchEvent(new Event("ht-demo-start"));
							document
								.getElementById("modes")
								?.scrollIntoView({ behavior: "smooth" });
						}}
						className={`${BTN_SECONDARY} group cursor-pointer gap-2.5`}
					>
						See how Cap works
						<span className="grid size-6 place-items-center rounded-full bg-[#E7EDF3] text-[rgba(17,17,17,0.65)] transition-colors duration-200 group-hover:bg-[#DCE4EC] group-hover:text-[#111111]">
							<ArrowDown className="size-3.5 transition-transform duration-200 group-hover:translate-y-[2px]" />
						</span>
					</button>
				</div>

				<div className="mt-5 flex items-center gap-2 text-[14px] text-[rgba(17,17,17,0.5)]">
					<span>Also available on</span>
					<span className="flex items-center gap-1">
						{isWindows || isLinux ? (
							<AltIcon label="macOS">
								<AppleGlyph className="size-4" />
							</AltIcon>
						) : null}
						{!isWindows ? (
							<AltIcon label="Windows">
								<WindowsGlyph className="size-[15px]" />
							</AltIcon>
						) : null}
						{!isLinux ? (
							<AltIcon label="Linux">
								<Image
									src="/logos/os/linux.svg"
									alt=""
									width={16}
									height={16}
									className="size-4 opacity-60"
								/>
							</AltIcon>
						) : null}
						<AltIcon label="Chrome">
							<Image
								src="/logos/browsers/google-chrome.svg"
								alt=""
								width={16}
								height={16}
								className="size-4 opacity-70"
							/>
						</AltIcon>
					</span>
				</div>
				<PhoneStage />
			</div>
		</section>
	);
};
