"use client";

import { Button } from "@cap/ui";
import { useCallback, useId, useRef, useState } from "react";
import { downloadLoomVideo } from "@/actions/loom";

type Status = "idle" | "fetching" | "downloading" | "converting" | "error";

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

export function LoomDownloader() {
	const inputId = useId();
	const [url, setUrl] = useState("");
	const [status, setStatus] = useState<Status>("idle");
	const [errorMessage, setErrorMessage] = useState("");
	const [convertProgress, setConvertProgress] = useState(0);
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

			setStatus("idle");
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

	return (
		<div className="flex flex-col gap-5">
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
				Paste any public Loom video link. We fetch the download URL server-side
				— your video is never stored on our servers.
			</div>
		</div>
	);
}
