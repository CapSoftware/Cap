"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
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

	const percent =
		progress && "progress" in progress
			? Math.max(0, Math.min(100, Math.round(progress.progress)))
			: null;

	return (
		<main className="flex min-h-[100dvh] items-center justify-center bg-gray-2 px-4 py-10">
			<div className="flex w-full max-w-md flex-col gap-4">
				<div className="flex flex-col gap-4 rounded-2xl border border-gray-4 bg-gray-1 p-6">
					<div className="flex flex-col gap-1.5">
						<h1 className="text-balance text-xl font-semibold text-gray-12">
							{failed
								? "Your recording needs attention"
								: "Getting the editor ready"}
						</h1>
						<output className="block text-sm leading-relaxed text-gray-11">
							{progress?.status === "failed"
								? "This recording did not finish uploading. Return to the device and recorder used to make it. In the browser recorder, check Recovered recordings for a download you can upload again."
								: failed
									? "Your recording could not finish preparing. Return to the recording for more details, or retry if available below."
									: "Your screen, camera and audio tracks are being lined up. The editor opens by itself in a moment."}
						</output>
					</div>
					{!failed && (
						<div className="flex flex-col gap-1.5">
							<div
								role="progressbar"
								aria-label="Recording preparation"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percent ?? undefined}
								className="relative h-1.5 overflow-hidden rounded-full bg-gray-3"
							>
								{percent === null ? (
									<span className="absolute inset-y-0 w-1/3 animate-[edit-processing_1.4s_ease-in-out_infinite] rounded-full bg-blue-9 motion-reduce:animate-none" />
								) : (
									<span
										className="absolute inset-y-0 left-0 rounded-full bg-blue-9 transition-[width] duration-300"
										style={{ width: `${percent}%` }}
									/>
								)}
							</div>
							{percent !== null && (
								<span className="text-xs tabular-nums text-gray-10">
									{percent}%
								</span>
							)}
						</div>
					)}
					{retryError && (
						<p role="alert" className="text-sm text-red-11">
							{retryError}
						</p>
					)}
					<div className="flex flex-wrap items-center gap-3">
						{canRetry && (
							<button
								type="button"
								disabled={retrying}
								className="rounded-lg bg-blue-9 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
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
							<a
								href="/dashboard/caps/record"
								className="text-sm font-medium text-blue-11 hover:text-blue-12"
							>
								Go to recorder
							</a>
						)}
						{failed && (
							<a
								href={`/s/${videoId}`}
								className="text-sm font-medium text-blue-11 hover:text-blue-12"
							>
								View recording
							</a>
						)}
					</div>
				</div>
				{!failed && (
					<SharedLinkCard
						videoId={videoId}
						title={
							justRecorded ? "Your Cap is already shared" : "Your share link"
						}
						description="Anyone with the link can watch it now. When you Save in the editor, the same link updates."
					/>
				)}
			</div>
			<style>{`
				@keyframes edit-processing {
					0% { left: -33%; }
					100% { left: 100%; }
				}
			`}</style>
		</main>
	);
}
