import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { preload } from "react-dom";
import { CapPlayer } from "@/components/cap-player/CapPlayer";
import { Lockup } from "@/components/infra/Lockup";
import {
	type DeveloperVideoPlayback,
	type DeveloperVideoQuery,
	developerVideoPlayback,
} from "@/lib/developer-video-params";
import {
	type DeveloperVideoPlayer,
	loadDeveloperVideoPlayer,
} from "@/lib/developer-video-player";
import {
	DEVELOPER_VIDEO_UNAVAILABLE,
	developerVideoReportHref,
} from "@/lib/developer-video-takedown";
import { INFRA_VIDEO_PUBLIC_FAILURE } from "@/lib/infra-video-view";
import { RefreshUntilReady } from "./RefreshUntilReady";

export type DeveloperVideoPageVariant = "share" | "embed";

const loadPlayer = cache(loadDeveloperVideoPlayer);

export async function developerVideoMetadata(
	playbackId: string,
): Promise<Metadata> {
	const player = await loadPlayer(playbackId);
	const title =
		player?.kind === "taken_down"
			? "Video not available"
			: (player?.name ?? "Video not found");
	const images =
		player?.kind === "playing" && player.poster ? [player.poster] : [];
	return {
		title,
		description: null,
		robots: { index: false, follow: false },
		openGraph: { title, type: "video.other", images },
		twitter: {
			card: images.length > 0 ? "summary_large_image" : "summary",
			title,
			images,
		},
	};
}

function Notice({
	title,
	detail,
	waiting = false,
}: {
	title: string;
	detail?: string;
	waiting?: boolean;
}) {
	return (
		<div
			role={waiting ? "status" : undefined}
			className="grid h-full w-full place-items-center bg-black px-5 py-4 text-center"
		>
			<div className="max-w-[420px]">
				{waiting && (
					<span
						aria-hidden="true"
						className="mx-auto mb-4 block size-[22px] animate-spin rounded-full border-2 border-[rgba(232,236,244,0.16)] border-t-[#E8ECF4] motion-reduce:animate-none"
					/>
				)}
				<p className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
					{title}
				</p>
				{detail && (
					<p className="m-0 mt-1.5 text-pretty text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.62)] [overflow-wrap:anywhere]">
						{detail}
					</p>
				)}
			</div>
		</div>
	);
}

function Stage({
	player,
	playback,
}: {
	player: DeveloperVideoPlayer;
	playback: DeveloperVideoPlayback;
}) {
	if (player.kind === "playing") {
		if (player.poster) {
			preload(player.poster, { as: "image", fetchPriority: "high" });
		}
		return (
			<CapPlayer
				source={player.source}
				poster={player.poster ?? undefined}
				title={player.name}
				aspectRatio="auto"
				className="h-full"
				autoPlay={playback.autoPlay}
				muted={playback.muted}
				loop={playback.loop}
				controls={playback.controls}
				startAt={playback.startAt}
				captions={player.captions ?? undefined}
				showCaptions={playback.captions}
			/>
		);
	}
	if (player.kind === "paused") {
		return (
			<Notice
				title="Playback is paused"
				detail="This video will play again when its owner resumes playback."
			/>
		);
	}
	if (player.kind === "failed") {
		return <Notice title={INFRA_VIDEO_PUBLIC_FAILURE} />;
	}
	if (player.kind === "taken_down") {
		return <Notice title={DEVELOPER_VIDEO_UNAVAILABLE} />;
	}
	return (
		<>
			<Notice
				waiting
				title={
					player.uploading ? "This video is being prepared" : "Processing video"
				}
				detail="This page updates when the video is ready to play."
			/>
			<RefreshUntilReady />
		</>
	);
}

// The embed sits on someone else's page, so its link only shows while the
// pointer is over a player whose controls are showing, or on keyboard focus.
const EMBED_REPORT_CLASS =
	"pointer-events-none absolute right-2 top-2 z-10 rounded-[6px] bg-[rgba(5,5,6,0.55)] px-2 py-1 text-[12px] leading-none text-[rgba(232,236,244,0.72)] opacity-0 outline-none transition-opacity duration-200 hover:text-[#E8ECF4] focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[rgba(232,236,244,0.6)] [.group:hover:not(:has([data-idle=true]))_&]:pointer-events-auto [.group:hover:not(:has([data-idle=true]))_&]:opacity-100";

export function DeveloperVideoView({
	playbackId,
	player,
	variant,
	playback = developerVideoPlayback({}, variant),
}: {
	playbackId: string;
	player: DeveloperVideoPlayer;
	variant: DeveloperVideoPageVariant;
	playback?: DeveloperVideoPlayback;
}) {
	// A taken down video gets one plain sentence and nothing from the video:
	// no player, poster, title or link. Every playback file answers 410.
	if (player.kind === "taken_down") {
		return (
			<div
				className={
					variant === "embed"
						? "fixed inset-0 grid place-items-center bg-black px-5 text-center"
						: "grid min-h-dvh place-items-center px-5 text-center"
				}
			>
				{variant === "embed" && <style>{"html,body{background:#000}"}</style>}
				<h1 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
					{DEVELOPER_VIDEO_UNAVAILABLE}
				</h1>
			</div>
		);
	}

	const reportHref = developerVideoReportHref(playbackId);

	if (variant === "embed") {
		return (
			<div className="group fixed inset-0 bg-black">
				<style>{"html,body{background:#000}"}</style>
				<h1 className="sr-only">{player.name}</h1>
				<Stage player={player} playback={playback} />
				<a
					href={reportHref}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Report this video"
					className={EMBED_REPORT_CLASS}
				>
					Report
				</a>
			</div>
		);
	}

	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col px-4 pb-12 sm:px-8">
			<header className="flex h-16 shrink-0 items-center">
				<Lockup height={20} />
			</header>
			<div className="flex flex-1 flex-col sm:justify-center">
				<div
					className="mx-auto w-full"
					style={{
						maxWidth: `max(280px, calc((100dvh - 220px) * ${player.width} / ${player.height}))`,
					}}
				>
					<div
						className="overflow-hidden rounded-[12px] bg-black shadow-[0_0_0_1px_rgba(222,230,246,0.1)]"
						style={{ aspectRatio: `${player.width} / ${player.height}` }}
					>
						<Stage player={player} playback={playback} />
					</div>
					<div className="mt-5 flex items-baseline justify-between gap-4">
						<h1 className="m-0 min-w-0 text-[18px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4] [overflow-wrap:anywhere]">
							{player.name}
						</h1>
						<a
							href={reportHref}
							aria-label="Report this video"
							className="shrink-0 rounded-[4px] text-[13px] leading-[1.3] text-[rgba(232,236,244,0.42)] outline-none transition-colors hover:text-[rgba(232,236,244,0.8)] focus-visible:text-[#E8ECF4] focus-visible:ring-1 focus-visible:ring-[rgba(232,236,244,0.6)]"
						>
							Report
						</a>
					</div>
				</div>
			</div>
		</div>
	);
}

export async function DeveloperVideoPage({
	playbackId,
	variant,
	query,
}: {
	playbackId: string;
	variant: DeveloperVideoPageVariant;
	query: DeveloperVideoQuery;
}) {
	const player = await loadPlayer(playbackId);
	if (!player) notFound();
	return (
		<DeveloperVideoView
			playbackId={playbackId}
			player={player}
			variant={variant}
			playback={developerVideoPlayback(query, variant)}
		/>
	);
}
