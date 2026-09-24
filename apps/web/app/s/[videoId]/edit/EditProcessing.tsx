"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import { useUploadProgress } from "../_components/ProgressCircle";

export function EditProcessing({ videoId }: { videoId: Video.VideoId }) {
	const router = useRouter();
	const progress = useUploadProgress(videoId, true);
	const [retrying, startRetry] = useTransition();
	const [retryError, setRetryError] = useState<string>();
	const ready = progress === null;
	const canRetry =
		progress?.status === "failed" ||
		(progress?.status === "error" && progress.hasRawFallback);
	const failed = progress?.status === "error" || progress?.status === "failed";

	useEffect(() => {
		if (ready) router.refresh();
	}, [ready, router]);

	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 p-6">
			<div className="w-full max-w-md space-y-4 rounded-xl border border-gray-5 bg-gray-1 p-6">
				<h1 className="text-xl font-medium text-gray-12">
					{failed
						? "Your recording needs attention"
						: "Preparing your recording"}
				</h1>
				<output className="block text-sm text-gray-11">
					{failed
						? "Your recording could not finish preparing. Return to the recording for more details, or retry if available below."
						: "The editor will open automatically when your recording is ready."}
				</output>
				{progress && "progress" in progress && (
					<progress
						aria-label="Recording preparation"
						max={100}
						value={progress.progress}
						className="w-full"
					/>
				)}
				{retryError && (
					<p role="alert" className="text-sm text-red-11">
						{retryError}
					</p>
				)}
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
				<a
					href={`/s/${videoId}`}
					className="block text-sm text-blue-11 underline"
				>
					View recording
				</a>
			</div>
		</main>
	);
}
