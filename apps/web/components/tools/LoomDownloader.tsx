"use client";

import { Button } from "@cap/ui";
import { useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { downloadLoomVideo } from "@/actions/loom";

type Status =
	| "idle"
	| "fetching"
	| "downloading"
	| "converting"
	| "success"
	| "error";

const MIGRATE_PROMO_CODE = "MIGRATE20";
const MIGRATE_CHECKOUT_HREF = `/pricing?promo=${MIGRATE_PROMO_CODE}&utm_source=loom-downloader&utm_campaign=migrate20`;

function triggerBlobDownload(blob: Blob, filename: string) {
	const blobUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = blobUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(blobUrl);
}

function needsConversion(contentType: string): boolean {
	return (
		contentType.includes("mp2t") ||
		contentType.includes("mpeg") ||
		contentType.includes("webm")
	);
}

function getInputFilename(contentType: string): string {
	if (contentType.includes("mp2t") || contentType.includes("mpeg")) {
		return "video.ts";
	}
	if (contentType.includes("webm")) {
		return "video.webm";
	}
	return "video.mp4";
}

async function convertBlobToMp4(
	blob: Blob,
	contentType: string,
	onProgress: (percent: number) => void,
): Promise<Blob> {
	const file = new File([blob], getInputFilename(contentType), {
		type: contentType,
	});
	const { convertMedia } = await import("@remotion/webcodecs");

	const result = await convertMedia({
		src: file,
		container: "mp4",
		videoCodec: "h264",
		audioCodec: "aac" as const,
		onProgress: ({ overallProgress }) => {
			if (overallProgress !== null) {
				onProgress(
					Math.min(100, Math.max(0, Math.round(overallProgress * 100))),
				);
			}
		},
	});

	const saved = await result.save();
	if (saved.size === 0) {
		throw new Error("Conversion produced an empty file");
	}
	return saved;
}

function PromoCodeChip() {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(MIGRATE_PROMO_CODE);
			setCopied(true);
			toast.success(`Code ${MIGRATE_PROMO_CODE} copied to clipboard`);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy code");
		}
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={`Copy discount code ${MIGRATE_PROMO_CODE}`}
			className="inline-flex items-center gap-2 px-3 py-1.5 font-mono text-sm font-semibold rounded-lg border border-dashed transition-colors border-blue-300 bg-white/60 text-blue-700 hover:bg-white hover:border-blue-400"
		>
			<span>{MIGRATE_PROMO_CODE}</span>
			<span className="text-[11px] uppercase tracking-wide text-blue-500">
				{copied ? "Copied" : "Tap to copy"}
			</span>
		</button>
	);
}

function MigrationBanner() {
	return (
		<div className="flex flex-col gap-3 p-4 rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 via-white to-blue-50 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase rounded-full bg-blue-600 text-white">
						Switch
					</span>
					<p className="text-sm font-semibold text-gray-900 sm:text-base">
						Switch from Loom to Cap — save 20%
					</p>
				</div>
				<p className="text-xs leading-relaxed text-gray-600 sm:text-sm">
					Migrating from Loom? Use{" "}
					<span className="font-mono font-semibold text-blue-700">
						{MIGRATE_PROMO_CODE}
					</span>{" "}
					at checkout for 20% off Cap Pro.
				</p>
			</div>
			<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
				<PromoCodeChip />
				<Button
					variant="blue"
					size="sm"
					href={MIGRATE_CHECKOUT_HREF}
					className="whitespace-nowrap"
				>
					Switch to Cap
				</Button>
			</div>
		</div>
	);
}

function MigrationSuccessState({
	downloadedName,
	onDownloadAnother,
}: {
	downloadedName: string;
	onDownloadAnother: () => void;
}) {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-start gap-3 p-4 rounded-xl border border-green-200 bg-green-50">
				<svg
					className="flex-shrink-0 w-5 h-5 mt-0.5 text-green-600"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={1.75}
					role="img"
				>
					<title>Download complete</title>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M9 12.75L11.25 15 15 9.75m-3 11.25a9 9 0 110-18 9 9 0 010 18z"
					/>
				</svg>
				<div className="flex flex-col gap-1">
					<p className="text-sm font-semibold text-green-900 sm:text-base">
						Your Loom video is downloading
					</p>
					<p className="text-xs leading-relaxed text-green-800 sm:text-sm">
						{downloadedName
							? `"${downloadedName}" is saving as an MP4.`
							: "Your MP4 is saving now."}{" "}
						Why stop at one?
					</p>
				</div>
			</div>

			<div className="flex flex-col gap-5 p-5 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white sm:p-7">
				<div className="flex flex-col gap-2">
					<span className="inline-flex self-start items-center px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase rounded-full bg-blue-600 text-white">
						Next step
					</span>
					<h3 className="text-lg font-semibold text-gray-900 sm:text-xl">
						Bring your whole Loom library to Cap
					</h3>
					<p className="text-sm leading-relaxed text-gray-700 sm:text-base">
						Skip the one-by-one downloads. Cap Pro's built-in Loom importer
						transfers your entire Loom workspace to Cap in a single click —
						titles, transcripts, and all. Use{" "}
						<span className="font-mono font-semibold text-blue-700">
							{MIGRATE_PROMO_CODE}
						</span>{" "}
						at checkout for 20% off your first year.
					</p>
				</div>

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
						<Button
							variant="blue"
							size="lg"
							href={MIGRATE_CHECKOUT_HREF}
							className="w-full sm:w-auto"
						>
							Migrate with Cap Pro — save 20%
						</Button>
						<Button
							variant="white"
							size="lg"
							href="/download"
							className="w-full sm:w-auto"
						>
							Download Cap free
						</Button>
					</div>
					<div className="flex items-center gap-2">
						<PromoCodeChip />
						<span className="text-xs text-gray-500">
							Applied automatically at checkout.
						</span>
					</div>
				</div>

				<ul className="grid grid-cols-1 gap-2 pt-2 border-t border-blue-100 sm:grid-cols-3 sm:gap-4 sm:pt-3">
					{[
						"Import your entire Loom library",
						"Keep titles, chapters & transcripts",
						"Cancel anytime — 20% off locked in",
					].map((line) => (
						<li
							key={line}
							className="flex items-start gap-2 text-xs text-gray-700 sm:text-sm"
						>
							<svg
								className="flex-shrink-0 w-4 h-4 mt-0.5 text-blue-600"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={2}
								role="img"
							>
								<title>Included</title>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M4.5 12.75l6 6 9-13.5"
								/>
							</svg>
							<span>{line}</span>
						</li>
					))}
				</ul>
			</div>

			<button
				type="button"
				onClick={onDownloadAnother}
				className="self-center text-sm font-medium transition-colors text-gray-500 hover:text-gray-800 hover:underline"
			>
				Download another Loom video
			</button>
		</div>
	);
}

export function LoomDownloader() {
	const inputId = useId();
	const [url, setUrl] = useState("");
	const [status, setStatus] = useState<Status>("idle");
	const [errorMessage, setErrorMessage] = useState("");
	const [convertProgress, setConvertProgress] = useState(0);
	const [lastDownloadedName, setLastDownloadedName] = useState("");
	const abortRef = useRef<AbortController | null>(null);

	const handleDownload = useCallback(async () => {
		if (!url.trim()) return;

		setStatus("fetching");
		setErrorMessage("");
		setConvertProgress(0);

		try {
			const result = await downloadLoomVideo(url.trim());

			if (!result.success || !result.videoId) {
				setStatus("error");
				setErrorMessage(result.error || "Something went wrong.");
				return;
			}

			const params = new URLSearchParams({ id: result.videoId });
			if (result.videoName) params.set("name", result.videoName);
			const proxyUrl = `/api/tools/loom-download?${params.toString()}`;

			setStatus("downloading");

			const controller = new AbortController();
			abortRef.current = controller;

			const response = await fetch(proxyUrl, {
				signal: controller.signal,
			});

			if (!response.ok) {
				setStatus("error");
				setErrorMessage("Failed to download the video. Please try again.");
				return;
			}

			const contentType = response.headers.get("Content-Type") ?? "video/mp4";
			const blob = await response.blob();

			const sanitizedName = result.videoName
				? result.videoName.replace(/[^a-zA-Z0-9\s-]/g, "").trim()
				: `loom-video-${Date.now()}`;

			if (needsConversion(contentType)) {
				setStatus("converting");
				setConvertProgress(0);

				try {
					const mp4Blob = await convertBlobToMp4(
						blob,
						contentType,
						setConvertProgress,
					);
					triggerBlobDownload(mp4Blob, `${sanitizedName}.mp4`);
				} catch {
					const fallbackExt = contentType.includes("webm") ? "webm" : "ts";
					triggerBlobDownload(blob, `${sanitizedName}.${fallbackExt}`);
				}
			} else {
				triggerBlobDownload(blob, `${sanitizedName}.mp4`);
			}

			setLastDownloadedName(result.videoName ?? "");
			setStatus("success");
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setStatus("idle");
				return;
			}
			setStatus("error");
			setErrorMessage("An unexpected error occurred. Please try again.");
		} finally {
			abortRef.current = null;
		}
	}, [url]);

	const handleDownloadAnother = useCallback(() => {
		setUrl("");
		setStatus("idle");
		setErrorMessage("");
		setConvertProgress(0);
		setLastDownloadedName("");
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			handleDownload();
		}
	};

	const isLoading =
		status === "fetching" ||
		status === "downloading" ||
		status === "converting";
	const isValidLoomUrl = url.trim().length > 0 && url.includes("loom.com");

	const buttonLabel =
		status === "fetching"
			? "Fetching..."
			: status === "downloading"
				? "Downloading..."
				: status === "converting"
					? `Converting to MP4... ${convertProgress}%`
					: "Download Video";

	if (status === "success") {
		return (
			<MigrationSuccessState
				downloadedName={lastDownloadedName}
				onDownloadAnother={handleDownloadAnother}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<MigrationBanner />

			<div className="flex flex-col gap-2 sm:gap-3">
				<label htmlFor={inputId} className="text-sm font-medium text-gray-700">
					Loom Video URL
				</label>
				<div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
					<input
						id={inputId}
						type="url"
						value={url}
						onChange={(e) => {
							setUrl(e.target.value);
							if (status === "error") {
								setStatus("idle");
								setErrorMessage("");
							}
						}}
						onKeyDown={handleKeyDown}
						placeholder="https://www.loom.com/share/..."
						className="w-full sm:flex-1 px-3 sm:px-4 h-[48px] sm:h-[44px] text-[16px] sm:text-[14px] text-gray-12 bg-gray-1 border border-gray-4 rounded-xl outline-0 transition-all duration-200 hover:bg-gray-2 hover:border-gray-5 focus:bg-gray-2 focus:border-gray-5 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 placeholder:text-gray-8"
						disabled={isLoading}
					/>
					<Button
						onClick={handleDownload}
						disabled={!isValidLoomUrl || isLoading}
						variant="primary"
						size="md"
						spinner={isLoading}
						className="w-full h-[48px] sm:h-auto sm:w-auto"
					>
						{buttonLabel}
					</Button>
				</div>
			</div>

			{status === "converting" && (
				<div className="flex flex-col gap-2">
					<div className="w-full bg-gray-3 rounded-full h-2 overflow-hidden">
						<div
							className="bg-blue-9 h-2 rounded-full transition-all duration-300 ease-out"
							style={{ width: `${convertProgress}%` }}
						/>
					</div>
					<p className="text-xs text-gray-500 text-center">
						Converting video to MP4 in your browser...
					</p>
				</div>
			)}

			{status === "error" && errorMessage && (
				<div className="flex items-start gap-2 p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl">
					<svg
						className="w-5 h-5 flex-shrink-0 mt-0.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={1.5}
						role="img"
					>
						<title>Error</title>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
						/>
					</svg>
					<span>{errorMessage}</span>
				</div>
			)}

			<div className="flex flex-col gap-3 pt-4 border-t border-gray-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-start gap-2 text-xs text-gray-500 sm:items-center">
					<svg
						className="w-4 h-4 flex-shrink-0 mt-0.5 sm:mt-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={1.5}
						role="img"
					>
						<title>Privacy</title>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
						/>
					</svg>
					Paste any public Loom link. Your video is never stored on our servers.
				</div>
				<a
					href={MIGRATE_CHECKOUT_HREF}
					className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline"
				>
					Import Loom videos with Cap Pro
					<svg
						className="w-3 h-3"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={2}
						role="img"
					>
						<title>Arrow</title>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M17.25 8.25L21 12m0 0l-3.75 3.75M21 12H3"
						/>
					</svg>
				</a>
			</div>
		</div>
	);
}
