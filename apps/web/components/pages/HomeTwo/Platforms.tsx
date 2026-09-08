"use client";

import { classNames } from "@cap/utils/helpers";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { getDownloadUrl } from "@/utils/platform";
import { Eyebrow } from "./Eyebrow";
import { AppleGlyph } from "./glyphs";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	grainBg,
	H_CARD,
	H_SECTION,
	MODE_THEME,
	MONO,
	meshStyle,
} from "./theme";

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

const TERMINAL = [
	{ prompt: true, text: "cap record start --mode studio --duration 30" },
	{ prompt: true, text: "cap export ./recording.cap --quality 4k" },
	{ prompt: true, text: "cap upload ./recording.mp4 --json" },
	{ prompt: false, text: '{ "url": "https://cap.so/s/x7f2k9" }' },
];

const Tile = ({
	href,
	title,
	body,
	icon,
}: {
	href: string;
	title: string;
	body: string;
	icon: React.ReactNode;
}) => (
	<Link
		href={href}
		className="group flex flex-col justify-between rounded-[20px] p-7 transition-colors duration-200 hover:bg-[#E5EAF1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
		style={grainBg(BAND)}
	>
		<span className="flex items-start justify-between">
			{icon}
			<ArrowUpRight className="size-4 text-[rgba(17,17,17,0.4)] transition-colors duration-200 group-hover:text-[#111111]" />
		</span>
		<span className="mt-10 block">
			<span className="block text-[19px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
				{title}
			</span>
			<span
				className={`${BODY_TEXT} mt-2 block text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.7)]`}
			>
				{body}
			</span>
		</span>
	</Link>
);

export const Platforms = () => {
	const { platform, isIntel } = useDetectPlatform();
	const current = platform ?? "macos";

	const desktops = [
		{
			key: "macos",
			name: "macOS",
			note: "Apple silicon and Intel. macOS 13.1 or newer.",
			href: getDownloadUrl("macos", isIntel),
			glyph: <AppleGlyph className="size-7" />,
			mode: "instant" as const,
		},
		{
			key: "windows",
			name: "Windows",
			note: "Windows 10 or newer.",
			href: getDownloadUrl("windows", false),
			glyph: <WindowsGlyph className="size-6" />,
			mode: "studio" as const,
		},
		{
			key: "linux",
			name: "Linux",
			note: "Debian and Ubuntu, as a .deb package.",
			href: getDownloadUrl("linux", false),
			glyph: (
				<Image
					src="/logos/os/linux.svg"
					alt=""
					width={28}
					height={28}
					className="size-7"
				/>
			),
			mode: "screenshot" as const,
		},
	];

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1200px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.screenshot.accent}>
						Every platform
					</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
					>
						Native on Mac, Windows and Linux
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[540px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						A real desktop app on all three, with the same recorder, editor, and
						share link. Plus a Chrome extension for the browser and a CLI for
						everything else.
					</p>
				</div>

				<div className="mt-14 grid gap-4 md:grid-cols-3">
					{desktops.map((desktop) => {
						const yours = desktop.key === current;
						return (
							<div
								key={desktop.key}
								className="flex flex-col justify-between rounded-[24px] p-8 md:min-h-[300px]"
								style={meshStyle(MODE_THEME[desktop.mode])}
							>
								<div className="flex items-start justify-between gap-4">
									<span className="grid size-14 place-items-center rounded-[16px] bg-white text-[#111111] shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_14px_30px_-18px_rgba(17,17,17,0.5)]">
										{desktop.glyph}
									</span>
									{yours ? (
										<span
											className={classNames(
												MONO,
												"rounded-full bg-white/70 px-3 py-1.5 text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.7)]",
											)}
										>
											Your device
										</span>
									) : null}
								</div>
								<div className="mt-10">
									<h3 className={`${H_CARD} text-[clamp(28px,2.6vw,34px)]`}>
										{desktop.name}
									</h3>
									<p
										className={`${BODY_TEXT} mt-2 text-[15.5px] leading-[1.45] text-[rgba(17,17,17,0.7)]`}
									>
										{desktop.note}
									</p>
									<Link
										href={desktop.href}
										className={classNames(
											BTN_PRIMARY,
											"mt-6 h-[46px] px-5 text-[15px]",
										)}
									>
										Download for {desktop.name}
									</Link>
								</div>
							</div>
						);
					})}
				</div>

				<div className="mt-4 grid gap-4 md:grid-cols-2">
					<Tile
						href="/download"
						title="Chrome extension"
						body="Record a tab or your whole screen without leaving the browser."
						icon={
							<Image
								src="/logos/browsers/google-chrome.svg"
								alt=""
								width={36}
								height={36}
								className="size-9"
							/>
						}
					/>
					<Link
						href="/docs"
						className="group flex flex-col rounded-[20px] p-7 transition-colors duration-200 hover:bg-[#E5EAF1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
						style={grainBg(BAND)}
					>
						<span className="flex items-start justify-between">
							<span className="block text-[19px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
								Built for developers
							</span>
							<ArrowUpRight className="size-4 shrink-0 text-[rgba(17,17,17,0.4)] transition-colors duration-200 group-hover:text-[#111111]" />
						</span>
						<span
							className={`${BODY_TEXT} mt-2 block text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.7)]`}
						>
							Record, export, and publish from the terminal, the API, or the MCP
							server.
						</span>
						<span
							className={classNames(
								MONO,
								"mt-5 block rounded-[12px] bg-[#111111] p-4 text-[11.5px] leading-[1.7] text-[#F8FAFC]",
							)}
						>
							{TERMINAL.map((line) => (
								<span
									key={line.text}
									className="block whitespace-pre-wrap break-words"
								>
									{line.prompt ? (
										<span className="text-[rgba(255,255,255,0.4)]">$ </span>
									) : null}
									<span className={line.prompt ? undefined : "text-[#8FDCBB]"}>
										{line.text}
									</span>
								</span>
							))}
						</span>
					</Link>
				</div>
			</div>
		</section>
	);
};
