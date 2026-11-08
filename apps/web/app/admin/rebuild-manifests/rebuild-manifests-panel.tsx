"use client";

import Link from "next/link";
import { useCallback, useId, useState } from "react";
import {
	adminListMissingManifestCandidates,
	adminRebuildMissingManifests,
	type RebuildManifestRow,
} from "@/actions/admin/rebuild-missing-manifests";

type Status =
	| { type: "idle" }
	| { type: "working"; label: string }
	| { type: "done"; mode: "check" | "rebuild"; rows: RebuildManifestRow[] }
	| { type: "error"; message: string };

const SUCCESS = new Set(["checked", "queued", "already-processing"]);

export function RebuildManifestsPanel() {
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<Status>({ type: "idle" });
	const inputId = useId();
	const working = status.type === "working";

	const run = useCallback(
		async (mode: "check" | "rebuild") => {
			if (!input.trim() || working) return;
			setStatus({
				type: "working",
				label: mode === "check" ? "Checking..." : "Rebuilding...",
			});
			try {
				setStatus({
					type: "done",
					mode,
					rows: await adminRebuildMissingManifests(input, mode),
				});
			} catch (err) {
				setStatus({
					type: "error",
					message: err instanceof Error ? err.message : "Something went wrong",
				});
			}
		},
		[input, working],
	);

	const loadNext = useCallback(async () => {
		if (working) return;
		setStatus({ type: "working", label: "Loading..." });
		try {
			const ids = await adminListMissingManifestCandidates();
			setInput(ids.join("\n"));
			setStatus({ type: "idle" });
		} catch (err) {
			setStatus({
				type: "error",
				message: err instanceof Error ? err.message : "Something went wrong",
			});
		}
	}, [working]);

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
					Rebuild missing manifests
				</h1>
				<p className="mt-1 text-sm text-gray-500">
					For desktop recordings whose segments uploaded but whose manifest
					never did. Check reads the uploaded segments and reports what a
					rebuilt manifest would contain. Rebuild writes it and starts
					processing. Recordings with missing segments are refused. Up to 10 at
					a time.
				</p>
			</div>

			<div className="space-y-5">
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
				<div className="flex gap-2">
					<button
						type="button"
						onClick={loadNext}
						disabled={working}
						className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
					>
						Load next 10
					</button>
					<button
						type="button"
						onClick={() => run("check")}
						disabled={!input.trim() || working}
						className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
					>
						Check
					</button>
					<button
						type="button"
						onClick={() => run("rebuild")}
						disabled={!input.trim() || working}
						className="flex-1 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40"
					>
						{working ? status.label : "Rebuild"}
					</button>
				</div>
			</div>

			{status.type === "done" && (
				<ul className="mt-4 space-y-2 text-sm">
					{status.rows.map((row) => (
						<li
							key={row.input}
							className={`rounded-lg border px-4 py-2 ${
								SUCCESS.has(row.status)
									? "border-emerald-200 bg-emerald-50 text-emerald-700"
									: "border-amber-200 bg-amber-50 text-amber-800"
							}`}
						>
							<span className="font-medium">{row.videoId ?? row.input}</span>:{" "}
							{row.status}
							{row.detail ? ` (${row.detail})` : ""}
							{row.shareUrl && (
								<Link
									href={row.shareUrl}
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
