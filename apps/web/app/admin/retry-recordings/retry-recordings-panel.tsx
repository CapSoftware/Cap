"use client";

import Link from "next/link";
import { useCallback, useId, useState } from "react";
import {
	adminRetryBlockedRecordings,
	type RetryBlockedRecordingResult,
} from "@/actions/admin/retry-blocked-recordings";

type Status =
	| { type: "idle" }
	| { type: "submitting" }
	| { type: "done"; results: RetryBlockedRecordingResult[] }
	| { type: "error"; message: string };

export function RetryRecordingsPanel() {
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<Status>({ type: "idle" });
	const inputId = useId();

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!input.trim() || status.type === "submitting") return;
			setStatus({ type: "submitting" });
			try {
				setStatus({
					type: "done",
					results: await adminRetryBlockedRecordings(input),
				});
			} catch (err) {
				setStatus({
					type: "error",
					message: err instanceof Error ? err.message : "Something went wrong",
				});
			}
		},
		[input, status.type],
	);

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
					Retry blocked recordings
				</h1>
				<p className="mt-1 text-sm text-gray-500">
					Re-run processing for desktop recordings whose source is saved but
					processing stopped (transfer budget used up, verification failed, or
					attempt limit reached). Up to 25 at a time.
				</p>
			</div>

			<form onSubmit={handleSubmit} className="space-y-5">
				<div>
					<label
						htmlFor={inputId}
						className="mb-1.5 block text-sm font-medium text-gray-700"
					>
						Video IDs or share URLs
					</label>
					<textarea
						id={inputId}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={6}
						placeholder="One per line"
						className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
					/>
				</div>
				<button
					type="submit"
					disabled={!input.trim() || status.type === "submitting"}
					className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40"
				>
					{status.type === "submitting" ? "Retrying..." : "Retry processing"}
				</button>
			</form>

			{status.type === "done" && (
				<ul className="mt-4 space-y-2 text-sm">
					{status.results.map((result) => (
						<li
							key={result.input}
							className={`rounded-lg border px-4 py-2 ${
								result.status === "queued"
									? "border-emerald-200 bg-emerald-50 text-emerald-700"
									: "border-amber-200 bg-amber-50 text-amber-800"
							}`}
						>
							<span className="font-medium">
								{result.videoId ?? result.input}
							</span>
							: {result.status}
							{result.detail ? ` (${result.detail})` : ""}
							{result.shareUrl && (
								<Link
									href={result.shareUrl}
									className="ml-2 underline underline-offset-2"
								>
									Open
								</Link>
							)}
						</li>
					))}
				</ul>
			)}

			{status.type === "error" && (
				<div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{status.message}
				</div>
			)}
		</div>
	);
}
