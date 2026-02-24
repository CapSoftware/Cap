"use client";

import { useCallback, useId, useRef, useState } from "react";
import { getVideoReplaceUploadUrl } from "@/actions/admin/replace-video";

type Status =
	| { type: "idle" }
	| { type: "uploading"; progress: number }
	| { type: "success" }
	| { type: "error"; message: string };

export function ReplaceVideoPanel() {
	const [videoId, setVideoId] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [status, setStatus] = useState<Status>({ type: "idle" });
	const xhrRef = useRef<XMLHttpRequest | null>(null);
	const videoIdInputId = useId();
	const fileInputId = useId();

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmedId = videoId.trim();
			if (!trimmedId || !file) return;

			setStatus({ type: "uploading", progress: 0 });

			try {
				const { presignedUrl } = await getVideoReplaceUploadUrl(trimmedId);

				await new Promise<void>((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					xhrRef.current = xhr;

					xhr.upload.addEventListener("progress", (e) => {
						if (e.lengthComputable) {
							setStatus({
								type: "uploading",
								progress: Math.round((e.loaded / e.total) * 100),
							});
						}
					});

					xhr.addEventListener("load", () => {
						if (xhr.status >= 200 && xhr.status < 300) {
							resolve();
						} else {
							reject(new Error(`Upload failed with status ${xhr.status}`));
						}
					});

					xhr.addEventListener("error", () => {
						reject(new Error("Upload failed"));
					});

					xhr.open("PUT", presignedUrl);
					xhr.setRequestHeader("Content-Type", "video/mp4");
					xhr.send(file);
				});

				setStatus({ type: "success" });
			} catch (err) {
				setStatus({
					type: "error",
					message: err instanceof Error ? err.message : "Something went wrong",
				});
			} finally {
				xhrRef.current = null;
			}
		},
		[videoId, file],
	);

	const canSubmit =
		videoId.trim().length > 0 && file !== null && status.type !== "uploading";

	return (
		<div className="mx-auto w-full max-w-xl px-5 py-8 md:px-8 md:py-10">
			<div className="mb-6">
				<h1 className="text-2xl font-semibold tracking-tight text-gray-900">
					Replace Video File
				</h1>
				<p className="mt-1 text-sm text-gray-500">
					Upload a new result.mp4 to replace the existing file for a given video
					ID.
				</p>
			</div>

			<form onSubmit={handleSubmit} className="space-y-5">
				<div>
					<label
						htmlFor={videoIdInputId}
						className="mb-1.5 block text-sm font-medium text-gray-700"
					>
						Video ID
					</label>
					<input
						id={videoIdInputId}
						type="text"
						value={videoId}
						onChange={(e) => setVideoId(e.target.value)}
						placeholder="e.g. abc123xyz"
						className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
					/>
				</div>

				<div>
					<label
						htmlFor={fileInputId}
						className="mb-1.5 block text-sm font-medium text-gray-700"
					>
						MP4 File
					</label>
					<input
						id={fileInputId}
						type="file"
						accept="video/mp4"
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
						className="w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
					/>
					{file && (
						<p className="mt-1.5 text-xs text-gray-500">
							{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
						</p>
					)}
				</div>

				<button
					type="submit"
					disabled={!canSubmit}
					className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40"
				>
					{status.type === "uploading"
						? `Uploading... ${status.progress}%`
						: "Upload & Replace"}
				</button>
			</form>

			{status.type === "uploading" && (
				<div className="mt-4">
					<div className="h-2 overflow-hidden rounded-full bg-gray-200">
						<div
							className="h-full rounded-full bg-blue-600 transition-all"
							style={{ width: `${status.progress}%` }}
						/>
					</div>
				</div>
			)}

			{status.type === "success" && (
				<div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
					Video file replaced successfully.
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
