"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { type CSSProperties, useEffect, useState, useTransition } from "react";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import {
	BoilFilter,
	Doodle,
	Squiggle,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder-parts";
import "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder.css";
import { useUploadProgress } from "../_components/ProgressCircle";
import { SharedLinkCard } from "./SharedLinkCard";

export function EditProcessing({
	videoId,
	justRecorded = false,
}: {
	videoId: Video.VideoId;
	justRecorded?: boolean;
}) {
	const router = useRouter();
	const progress = useUploadProgress(videoId, true);
	const [retrying, startRetry] = useTransition();
	const [retryError, setRetryError] = useState<string>();
	const ready = progress === null;
	const canRetry = progress?.status === "error" && progress.hasRawFallback;
	const failed = progress?.status === "error" || progress?.status === "failed";

	useEffect(() => {
		if (ready) router.refresh();
	}, [ready, router]);

	const reported =
		progress && "progress" in progress
			? Math.max(0, Math.min(100, Math.round(progress.progress)))
			: 0;
	const percent = reported > 0 ? reported : null;

	return (
		<main className="cap-rec flex min-h-[100dvh] flex-col items-center justify-center bg-[var(--rec-window)] px-4 pb-16 pt-10 text-center">
			<BoilFilter />
			<Doodle kind={failed ? "error" : "tracks"} />
			<h1 className="rec-rise mt-6 text-balance text-[24px] font-medium tracking-[-0.01em]">
				{failed ? "Your recording needs attention" : "Lining up your tracks"}
			</h1>
			<output
				className="rec-rise mt-2 block max-w-md text-balance text-[15px] leading-relaxed text-[var(--rec-text-2)]"
				style={{ "--d": "0.05s" } as CSSProperties}
			>
				{progress?.status === "failed"
					? "This recording did not finish uploading. Return to the device and recorder used to make it. In the browser recorder, check Recovered recordings for a download you can upload again."
					: failed
						? "Your recording could not finish preparing. Return to the recording for more details, or retry if available below."
						: "Your screen, camera and audio are being placed on the timeline. The editor opens by itself in a moment."}
			</output>
			{!failed && (
				<div
					className="rec-rise mt-9"
					style={{ "--d": "0.1s" } as CSSProperties}
					role="progressbar"
					aria-label="Recording preparation"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent ?? undefined}
				>
					<Squiggle progress={percent === null ? null : percent / 100} />
				</div>
			)}
			{retryError && (
				<p role="alert" className="mt-4 text-[13px] text-[var(--rec-red)]">
					{retryError}
				</p>
			)}
			{(canRetry || failed) && (
				<div className="mt-7 flex flex-wrap items-center justify-center gap-2">
					{canRetry && (
						<button
							type="button"
							disabled={retrying}
							className="rec-btn is-accent"
							onClick={() => {
								setRetryError(undefined);
								startRetry(async () => {
									try {
										await retryVideoProcessing({ videoId });
										router.refresh();
									} catch (cause) {
										setRetryError(
											cause instanceof Error
												? cause.message
												: "Processing could not restart. Please try again.",
										);
									}
								});
							}}
						>
							{retrying ? "Retrying…" : "Retry processing"}
						</button>
					)}
					{progress?.status === "failed" && (
						<a href="/dashboard/caps/record" className="rec-btn">
							Go to recorder
						</a>
					)}
					{failed && (
						<a href={`/s/${videoId}`} className="rec-btn">
							View recording
						</a>
					)}
				</div>
			)}
			{!failed && (
				<SharedLinkCard
					videoId={videoId}
					title={
						justRecorded ? "Your Cap is already shared" : "Your share link"
					}
					description="Anyone with the link can watch it now. When you save in the editor, the same link updates."
					className="rec-rise mt-10 w-full max-w-md"
				/>
			)}
		</main>
	);
}
