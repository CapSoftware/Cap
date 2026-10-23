"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreVideoToOriginal } from "@/actions/videos/save-edits";

export function EditRecovery({
	videoId,
	canRestore,
}: {
	videoId: Video.VideoId;
	canRestore: boolean;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string>();
	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 p-6">
			<div className="w-full max-w-md space-y-4 rounded-xl border border-gray-5 bg-gray-1 p-6">
				<h1 className="text-xl font-medium text-gray-12">
					Your edit is still processing
				</h1>
				<p className="text-sm text-gray-11">
					{canRestore
						? "If this edit could not finish, you can restore the original recording. Your original source is preserved."
						: "You can view the recording while your edit finishes. If processing does not finish, contact support for help."}
				</p>
				{error ? (
					<p role="alert" className="text-sm text-red-11">
						{error}
					</p>
				) : null}
				{canRestore ? (
					<button
						type="button"
						disabled={pending}
						className="rounded-lg bg-blue-9 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
						onClick={() => {
							setError(undefined);
							startTransition(async () => {
								try {
									await restoreVideoToOriginal(videoId);
									router.push(`/s/${videoId}`);
									router.refresh();
								} catch (cause) {
									setError(
										cause instanceof Error
											? cause.message
											: "The original could not be restored. Please try again.",
									);
								}
							});
						}}
					>
						{pending ? "Preparing recovery..." : "Restore original"}
					</button>
				) : null}
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
