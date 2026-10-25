"use client";

import { classNames } from "@cap/utils/helpers";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ArrowUpRight, Download, Monitor } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { getDownloadUrl } from "@/utils/platform";
import { AppleGlyph } from "../glyphs";
import { MONO } from "../theme";
import { Badge, Em, Section, SectionHead, TONES } from "./kit";

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

const TILE =
	"flex flex-col rounded-[20px] bg-white p-6 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_1px_2px_rgba(17,17,17,0.03)]";

const Desktop = ({
	name,
	note,
	href,
	glyph,
	yours,
}: {
	name: string;
	note: string;
	href: string;
	glyph: ReactNode;
	yours: boolean;
}) => (
	<div className={TILE}>
		<div className="flex items-center justify-between">
			<span className="grid size-11 place-items-center rounded-[12px] bg-[#F1F3F6] text-[#111111]">
				{glyph}
			</span>
			{yours ? (
				<span className="text-[13px] text-[rgba(17,17,17,0.64)]">
					Your device
				</span>
			) : null}
		</div>
		<h3 className="mt-8 text-[22px] font-normal tracking-[-0.02em] text-[#111111]">
			{name}
		</h3>
		<div className="mt-1 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.64)]">
			{note}
		</div>
		<Link
			href={href}
			prefetch={false}
			className={classNames(
				"mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-[10px] text-[14.5px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
				yours
					? "bg-[#111111] text-white hover:bg-[#2A2A2A]"
					: "bg-[#F1F3F6] text-[#111111] hover:bg-[#E6EAEF]",
			)}
		>
			<Download className="size-4" />
			Download for {name}
		</Link>
	</div>
);

const TERMINAL = [
	"cap record start --mode studio --duration 30",
	"cap export ./recording.cap --quality 4k",
	"cap upload ./recording.mp4 --json",
];

export const PlatformsSection = () => {
	const { platform, isIntel } = useDetectPlatform();
	const current = platform ?? "macos";
	return (
		<Section anchor="platforms" tone={TONES.platforms}>
			<SectionHead
				title="Native on Mac, Windows and Linux"
				badge={<Badge icon={<Monitor />}>Every platform</Badge>}
			>
				A real desktop app on all three, with{" "}
				<Em>the same recorder, editor, and share link</Em>. Plus a Chrome
				extension and a CLI for everything else.
			</SectionHead>
			<div className="mt-14 grid gap-3 md:grid-cols-3">
				<Desktop
					name="macOS"
					note="Apple silicon and Intel. macOS 13.1 or newer."
					href={getDownloadUrl("macos", isIntel)}
					glyph={<AppleGlyph className="size-5" />}
					yours={current === "macos"}
				/>
				<Desktop
					name="Windows"
					note="Windows 10 or newer."
					href={getDownloadUrl("windows", false)}
					glyph={<WindowsGlyph className="size-[18px]" />}
					yours={current === "windows"}
				/>
				<Desktop
					name="Linux"
					note="Debian and Ubuntu, as a .deb package."
					href={getDownloadUrl("linux", false)}
					glyph={
						<Image
							src="/logos/os/linux.svg"
							alt=""
							width={22}
							height={22}
							className="size-[22px]"
						/>
					}
					yours={current === "linux"}
				/>
			</div>
			<div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.4fr]">
				<Link
					href="/download"
					className={classNames(
						TILE,
						"group justify-between transition-shadow duration-200 hover:shadow-[0_0_0_1px_rgba(17,17,17,0.12)]",
					)}
				>
					<span className="flex items-start justify-between">
						<Image
							src="/logos/browsers/google-chrome.svg"
							alt=""
							width={36}
							height={36}
							className="size-9"
						/>
						<ArrowUpRight className="size-4 text-[rgba(17,17,17,0.4)] transition-colors group-hover:text-[#111111]" />
					</span>
					<div className="mt-8">
						<h3 className="block text-[18px] font-normal tracking-[-0.02em] text-[#111111]">
							Chrome extension
						</h3>
						<span className="mt-1 block text-[14.5px] text-[rgba(17,17,17,0.64)]">
							Record a tab or your whole screen without leaving the browser.
						</span>
					</div>
				</Link>
				<Link
					href="/docs"
					className={classNames(
						TILE,
						"group transition-shadow duration-200 hover:shadow-[0_0_0_1px_rgba(17,17,17,0.12)]",
					)}
				>
					<div className="flex items-start justify-between">
						<h3 className="block text-[18px] font-normal tracking-[-0.02em] text-[#111111]">
							Built for developers
						</h3>
						<ArrowUpRight className="size-4 text-[rgba(17,17,17,0.4)] transition-colors group-hover:text-[#111111]" />
					</div>
					<span className="mt-1 block text-[14.5px] text-[rgba(17,17,17,0.64)]">
						Record, export, and publish from the terminal, the API, or the MCP
						server.
					</span>
					<span
						className={classNames(
							MONO,
							"mt-5 block rounded-[12px] bg-[#F4F5F7] p-4 text-[12px] leading-[1.8] text-[#33363D]",
						)}
					>
						{TERMINAL.map((line) => (
							<span key={line} className="block break-words">
								<span className="text-[rgba(17,17,17,0.35)]">$ </span>
								{line}
							</span>
						))}
					</span>
				</Link>
			</div>
		</Section>
	);
};
