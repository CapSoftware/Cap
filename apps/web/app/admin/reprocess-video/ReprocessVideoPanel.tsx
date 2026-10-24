"use client";

import Link from "next/link";
import { useCallback, useId, useState } from "react";
import { adminReprocessVideo } from "@/actions/admin/reprocess-video";

type Status =
	| { type: "idle" }
	| { type: "submitting" }
	| {
			type: "success";
			videoId: string;
			name: string | null;
			shareUrl: string;
	  }
	| { type: "error"; message: string };

export function ReprocessVideoPanel() {
	const [videoInput, setVideoInput] = useState("");
	const [status, setStatus] = useState<Status>({ type: "idle" });
	const videoInputId = useId();

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmedInput = videoInput.trim();
			if (!trimmedInput || status.type === "submitting") return;

			setStatus({ type: "submitting" });

			try {
				const result = await adminReprocessVideo(trimmedInput);
				setStatus({
					type: "success",
					videoId: result.videoId,
					name: result.name,
					shareUrl: result.shareUrl,
				});
			} catch (err) {
				setStatus({
					type: "error",
					message: err instanceof Error ? err.message : "Something went wrong",
				});
			}
		},
		[videoInput, status.type],
	);

	const canSubmit =
		videoInput.trim().length > 0 && status.type !== "submitting";

	return (
		<div className="mx-auto w-full max-w-xl px-5 py-8 md:px-8 md:py-10">
			<div className="mb-6">
				<Link
					href="/admin"
					className="mb-4 inline-flex text-sm font-medium text-gray-500 transition hover:text-gray-900"
				>
					Back to admin
				</Link>
				<h1 className="text-2xl font-semibold tracking-tight text-gray-900">
					Reprocess Video
				</h1>
				<p className="mt-1 text-sm text-gray-500">
					Re-encode the existing result.mp4 for a video and replace it in
					storage.
				</p>
			</div>

			<form onSubmit={handleSubmit} className="space-y-5">
				<div>
					<label
						htmlFor={videoInputId}
						className="mb-1.5 block text-sm font-medium text-gray-700"
					>
						Video ID or share URL
					</label>
					<input
						id={videoInputId}
						type="text"
						value={videoInput}
						onChange={(e) => setVideoInput(e.target.value)}
						placeholder="https://cap.so/s/001t7gwqk627xx4"
						className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
					/>
				</div>

				<button
					type="submit"
					disabled={!canSubmit}
					className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40"
				>
					{status.type === "submitting" ? "Starting..." : "Start Reprocess"}
				</button>
			</form>

			{status.type === "success" && (
				<div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
					<div className="font-medium">Reprocess started</div>
					<div className="mt-1">
						{status.name ?? status.videoId} is processing in the background.
					</div>
					<Link
						href={status.shareUrl}
						className="mt-2 inline-flex font-medium text-emerald-800 underline underline-offset-2"
					>
						Open share page
					</Link>
				</div>
			)}

			{status.type === "error" && (
				<div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{status.message}
				</div>
			)}
		</div>
	);
}
