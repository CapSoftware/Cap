"use client";

import { classNames } from "@cap/utils/helpers";
import type { RefObject } from "react";
import { useState } from "react";
import { CapLogoMark, CapPlay } from "./capIcons";
import { TrafficLights, WindowsCaptionControls } from "./chrome";
import { useVideoAttrs, VIDEO_POSTERS } from "./media";
import { useIsWindowsDemo } from "./platform";

/**
 * A browser window showing the Cap share page an instant recording produces —
 * the payoff shot for Instant Mode: paste the link, viewers watch and comment
 * in the browser. The reaction pills are live so the visitor can leave one.
 */
export const CapShareWindow = ({
	visible,
	width,
	height,
	commentVisible,
	videoRef,
	title = "Dashboard walkthrough",
	url = "cap.link/dashboard-walkthrough",
	duration = "0:32",
}: {
	visible: boolean;
	width: number;
	height: number;
	commentVisible: boolean;
	videoRef: RefObject<HTMLVideoElement | null>;
	title?: string;
	url?: string;
	duration?: string;
}) => {
	const isWindows = useIsWindowsDemo();
	const screenVideo = useVideoAttrs(VIDEO_POSTERS.screen, visible);
	const [reacted, setReacted] = useState<Record<string, boolean>>({});

	return (
		<div
			inert={!visible}
			data-demo-anchor="share-window"
			className={classNames(
				"absolute transition-[opacity,transform] duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
				visible
					? "opacity-100 [transform:scale(1)_translateY(0)]"
					: "pointer-events-none opacity-0 [transform:scale(0.96)_translateY(18px)]",
			)}
			style={{ width, height }}
		>
			<div
				className="flex h-full w-full flex-col overflow-hidden"
				style={{
					borderRadius: isWindows ? 8 : 10,
					background: "#ffffff",
					border: "1px solid rgba(0,0,0,0.1)",
					boxShadow: "0 28px 80px rgba(0,0,0,0.28), 0 4px 18px rgba(0,0,0,0.1)",
				}}
			>
				{/* browser chrome */}
				<div
					className="flex h-11 shrink-0 items-center gap-3 border-b px-3.5"
					style={{ background: "#f6f7f9", borderColor: "rgba(0,0,0,0.07)" }}
				>
					{isWindows ? null : <TrafficLights />}
					<div className="flex items-center gap-2 text-[rgba(17,17,17,0.4)]">
						<svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
							<path
								d="m14 6-6 6 6 6"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							className="size-4 opacity-50"
						>
							<path
								d="m10 6 6 6-6 6"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
					<div className="flex min-w-0 flex-1 justify-center">
						<span
							className="flex h-7 w-[62%] min-w-0 items-center justify-center gap-1.5 rounded-lg text-[12px]"
							style={{
								background: "rgba(17,17,17,0.05)",
								color: "rgba(17,17,17,0.7)",
							}}
						>
							<svg
								aria-hidden="true"
								viewBox="0 0 24 24"
								className="size-3 opacity-60"
							>
								<rect
									x="5"
									y="10"
									width="14"
									height="10"
									rx="2"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								/>
								<path
									d="M8 10V7a4 4 0 0 1 8 0v3"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								/>
							</svg>
							<span className="truncate">{url}</span>
						</span>
					</div>
					{isWindows ? (
						<WindowsCaptionControls className="-mr-3.5 h-11" />
					) : (
						<span className="w-10" />
					)}
				</div>

				{/* share page */}
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center gap-2.5 px-5 pb-3 pt-4">
						<CapLogoMark className="size-7" />
						<div className="min-w-0 flex-1 leading-tight">
							<p className="truncate text-[14px] font-semibold text-[#111111]">
								{title}
							</p>
							<p className="text-[11.5px] text-[rgba(17,17,17,0.5)]">
								Richie · just now · {duration}
							</p>
						</div>
						<span
							data-scene-anchor="share-button"
							className="flex h-8 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-white"
							style={{ background: "linear-gradient(180deg,#3b82f6,#2563eb)" }}
						>
							Share
						</span>
					</div>

					{/* player */}
					<div className="relative mx-5 overflow-hidden rounded-xl bg-black">
						<video
							ref={videoRef}
							className="aspect-[16/9] w-full object-cover"
							src="/illustrations/homepage-animation.mp4"
							muted
							loop
							playsInline
							{...screenVideo}
						/>
						{/* player controls */}
						<div
							className="absolute inset-x-0 bottom-0 flex items-center gap-3 px-4 pb-2.5 pt-8 text-white"
							style={{
								background:
									"linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))",
							}}
						>
							<CapPlay className="h-3 w-auto" />
							<div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/25">
								<span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-white" />
							</div>
							<span className="text-[11px] tabular-nums text-white/90">
								0:11 / {duration}
							</span>
						</div>
					</div>

					{/* reactions + comment */}
					<div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
						<div
							data-demo-anchor="share-reactions"
							className="flex items-center gap-2"
						>
							{["👍", "🔥", "❤️"].map((emoji) => (
								<button
									key={emoji}
									type="button"
									aria-label={`React with ${emoji}`}
									onClick={() =>
										setReacted((prev) => ({ ...prev, [emoji]: !prev[emoji] }))
									}
									className={classNames(
										"flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors duration-150",
										reacted[emoji]
											? "border-[#5eb1ef] bg-[#e6f4fe]"
											: "border-[rgba(0,0,0,0.08)] hover:bg-[rgba(17,17,17,0.04)]",
									)}
									style={{ color: "rgba(17,17,17,0.7)" }}
								>
									{emoji}
									<span className="text-[11px] text-[rgba(17,17,17,0.45)]">
										{(emoji === "🔥" ? 2 : 1) + (reacted[emoji] ? 1 : 0)}
									</span>
								</button>
							))}
							<span className="flex-1" />
							<span className="text-[11.5px] text-[rgba(17,17,17,0.45)]">
								3 views
							</span>
						</div>

						<div
							className={classNames(
								"flex items-start gap-2.5 transition-[opacity,transform] duration-[400ms] ease-out",
								commentVisible
									? "translate-y-0 opacity-100"
									: "translate-y-2 opacity-0",
							)}
						>
							<span
								className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
								style={{
									background: "linear-gradient(135deg,#7B5FD0,#B9A5F2)",
								}}
							>
								S
							</span>
							<div className="min-w-0 flex-1 rounded-xl bg-[#F4F6F9] px-3 py-2">
								<p className="text-[11.5px] font-medium text-[#111111]">
									Sofia
									<span className="ml-1.5 font-normal text-[rgba(17,17,17,0.4)]">
										at 0:12
									</span>
								</p>
								<p className="text-[12.5px] text-[rgba(17,17,17,0.75)]">
									Perfect — shipping this today 🔥
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
