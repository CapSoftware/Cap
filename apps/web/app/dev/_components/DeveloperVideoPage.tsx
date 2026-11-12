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
import { INFRA_VIDEO_PUBLIC_FAILURE } from "@/lib/infra-video-view";
import { RefreshUntilReady } from "./RefreshUntilReady";

export type DeveloperVideoPageVariant = "share" | "embed";

const loadPlayer = cache(loadDeveloperVideoPlayer);

export async function developerVideoMetadata(
	playbackId: string,
): Promise<Metadata> {
	const player = await loadPlayer(playbackId);
	const title = player?.name ?? "Video not found";
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
	return (
		<>
			<Notice
				waiting
				title={player.uploading ? "Waiting for the upload" : "Processing video"}
				detail="This page updates when the video is ready to play."
			/>
			<RefreshUntilReady />
		</>
	);
}

export function DeveloperVideoView({
	player,
	variant,
	playback = developerVideoPlayback({}, variant),
}: {
	player: DeveloperVideoPlayer;
	variant: DeveloperVideoPageVariant;
	playback?: DeveloperVideoPlayback;
}) {
	if (variant === "embed") {
		return (
			<div className="fixed inset-0 bg-black">
				<style>{"html,body{background:#000}"}</style>
				<h1 className="sr-only">{player.name}</h1>
				<Stage player={player} playback={playback} />
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
					<h1 className="m-0 mt-5 text-[18px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4] [overflow-wrap:anywhere]">
						{player.name}
					</h1>
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
			player={player}
			variant={variant}
			playback={developerVideoPlayback(query, variant)}
		/>
	);
}
