"use client";

import { Button } from "@cap/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
	getLoomBrowserConversionErrorMessage,
	getLoomBrowserConversionSupport,
	isLoomBrowserConversionAbort,
	saveLoomStreamAsMp4,
} from "@/lib/loom-browser-conversion";
import { resolveLoomBrowserDownload } from "@/lib/loom-browser-download";

type Status =
	| "idle"
	| "fetching"
	| "downloading"
	| "converting"
	| "success"
	| "error";

type BrowserConversion = {
	url: string;
	filename: string;
	videoName: string;
};

type CompletionKind = "download-started" | "ready";

const MIGRATE_PROMO_CODE = "MIGRATE20";
const MIGRATE_CHECKOUT_HREF = `/pricing?promo=${MIGRATE_PROMO_CODE}&utm_source=loom-downloader&utm_campaign=migrate20`;

function triggerUrlDownload(url: string, filename: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.rel = "noreferrer";
	link.target = "_blank";
	link.referrerPolicy = "no-referrer";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

function triggerBlobDownload(blob: Blob, filename: string) {
	const blobUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = blobUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	return blobUrl;
}

function getDownloadFilename(videoName: string | undefined, fallback: string) {
	const sanitizedName = videoName
		? videoName.replace(/[^a-zA-Z0-9\s-]/g, "").trim()
		: "";
	return `${sanitizedName || fallback}.mp4`;
}

function PromoCodeChip() {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(MIGRATE_PROMO_CODE);
			setCopied(true);
			toast.success(`优惠码 ${MIGRATE_PROMO_CODE} 已复制到剪贴板`);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("复制优惠码失败");
		}
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={`复制优惠码 ${MIGRATE_PROMO_CODE}`}
			className="inline-flex items-center gap-2 px-3 py-1.5 font-mono text-sm font-semibold rounded-lg border border-dashed transition-colors border-blue-300 bg-white/60 text-blue-700 hover:bg-white hover:border-blue-400"
		>
			<span>{MIGRATE_PROMO_CODE}</span>
			<span className="text-[11px] uppercase tracking-wide text-blue-500">
				{copied ? "已复制" : "点击复制"}
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
						迁移
					</span>
					<p className="text-sm font-semibold text-gray-900 sm:text-base">
						从 Loom 迁移到 Cap，节省 20%
					</p>
				</div>
				<p className="text-xs leading-relaxed text-gray-600 sm:text-sm">
					从 Loom 迁移？结账时使用{" "}
					<span className="font-mono font-semibold text-blue-700">
						{MIGRATE_PROMO_CODE}
					</span>{" "}
					即可享受 Cap 专业版八折优惠。
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
					迁移到 Cap
				</Button>
			</div>
		</div>
	);
}

function MigrationSuccessState({
	completionKind,
	downloadedName,
	openUrl,
	onDownloadAnother,
}: {
	completionKind: CompletionKind;
	downloadedName: string;
	openUrl: string | null;
	onDownloadAnother: () => void;
}) {
	const isReady = completionKind === "ready";

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
					<title>下载完成</title>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M9 12.75L11.25 15 15 9.75m-3 11.25a9 9 0 110-18 9 9 0 010 18z"
					/>
				</svg>
				<div className="flex flex-col gap-1">
					<p className="text-sm font-semibold text-green-900 sm:text-base">
						{isReady ? "MP4 已准备就绪" : "下载已开始"}
					</p>
					<p className="text-xs leading-relaxed text-green-800 sm:text-sm">
						{isReady
							? downloadedName
								? `“${downloadedName}”已保存为 MP4。`
								: "MP4 已保存。"
							: downloadedName
								? `正在将“${downloadedName}”下载为 MP4。`
								: "浏览器正在下载 MP4。"}{" "}
						{openUrl ? "现在可以打开。" : "请从下载文件夹或所选保存位置打开。"}
					</p>
					{openUrl && (
						<a
							href={openUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex self-start mt-2 px-3 py-1.5 text-xs font-semibold rounded-lg border border-green-300 bg-white text-green-800 transition-colors hover:bg-green-100"
						>
							打开 MP4
						</a>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-5 p-5 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white sm:p-7">
				<div className="flex flex-col gap-2">
					<span className="inline-flex self-start items-center px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase rounded-full bg-blue-600 text-white">
						下一步
					</span>
					<h3 className="text-lg font-semibold text-gray-900 sm:text-xl">
						将整个 Loom 视频库迁移到 Cap
					</h3>
					<p className="text-sm leading-relaxed text-gray-700 sm:text-base">
						无需逐一下载。Cap 专业版内置 Loom 导入器，一键将整个 Loom
						工作区迁移到 Cap，包括标题、文字稿等所有内容。结账时使用{" "}
						<span className="font-mono font-semibold text-blue-700">
							{MIGRATE_PROMO_CODE}
						</span>{" "}
						首年可享八折优惠。
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
							使用 Cap 专业版迁移，节省 20%
						</Button>
						<Button
							variant="white"
							size="lg"
							href="/download"
							className="w-full sm:w-auto"
						>
							免费下载 Cap
						</Button>
					</div>
					<div className="flex items-center gap-2">
						<PromoCodeChip />
						<span className="text-xs text-gray-500">结账时自动应用。</span>
					</div>
				</div>

				<ul className="grid grid-cols-1 gap-2 pt-2 border-t border-blue-100 sm:grid-cols-3 sm:gap-4 sm:pt-3">
					{[
						"导入整个 Loom 视频库",
						"保留标题、章节和文字稿",
						"随时取消，锁定八折优惠",
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
								<title>已包含</title>
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
				下载其他 Loom 视频
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
	const [lastCompletionKind, setLastCompletionKind] =
		useState<CompletionKind>("ready");
	const [lastDownloadObjectUrl, setLastDownloadObjectUrl] = useState<
		string | null
	>(null);
	const abortRef = useRef<AbortController | null>(null);
	const downloadObjectUrlRef = useRef<string | null>(null);

	const updateDownloadObjectUrl = useCallback((objectUrl: string | null) => {
		if (downloadObjectUrlRef.current) {
			URL.revokeObjectURL(downloadObjectUrlRef.current);
		}

		downloadObjectUrlRef.current = objectUrl;
		setLastDownloadObjectUrl(objectUrl);
	}, []);

	useEffect(
		() => () => {
			if (downloadObjectUrlRef.current) {
				URL.revokeObjectURL(downloadObjectUrlRef.current);
			}
		},
		[],
	);

	const runBrowserConversion = useCallback(
		async (conversion: BrowserConversion) => {
			setStatus("converting");
			setErrorMessage("");
			setConvertProgress(0);
			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const convertedBlob = await saveLoomStreamAsMp4({
					url: conversion.url,
					filename: conversion.filename,
					signal: controller.signal,
					onProgress: ({ percent }) => {
						setConvertProgress(percent);
					},
				});
				let objectUrl: string | null = null;
				if (convertedBlob) {
					objectUrl = triggerBlobDownload(convertedBlob, conversion.filename);
				}

				updateDownloadObjectUrl(objectUrl);
				setLastCompletionKind("ready");
				setLastDownloadedName(conversion.videoName);
				setStatus("success");
			} catch (err) {
				if (
					(err instanceof DOMException && err.name === "AbortError") ||
					isLoomBrowserConversionAbort(err)
				) {
					setStatus("idle");
					return;
				}

				setStatus("error");
				setErrorMessage(
					getLoomBrowserConversionErrorMessage(err) ?? "发生意外错误，请重试。",
				);
			} finally {
				abortRef.current = null;
			}
		},
		[updateDownloadObjectUrl],
	);

	const handleDownload = useCallback(async () => {
		if (!url.trim()) return;

		setStatus("fetching");
		setErrorMessage("");
		setConvertProgress(0);

		try {
			const result = await resolveLoomBrowserDownload(url.trim());

			if (!result.success || !result.videoId) {
				setStatus("error");
				setErrorMessage(result.error || "出现问题。");
				return;
			}

			const filename = getDownloadFilename(
				result.videoName,
				`loom-video-${Date.now()}`,
			);

			if (!result.downloadUrl) {
				setStatus("error");
				setErrorMessage("无法获取视频下载地址。");
				return;
			}

			if (result.downloadMode === "direct-download") {
				setStatus("downloading");
				triggerUrlDownload(result.downloadUrl, filename);
				updateDownloadObjectUrl(null);
				setLastCompletionKind("download-started");
				setLastDownloadedName(result.videoName ?? "");
				setStatus("success");
				return;
			}

			const support = getLoomBrowserConversionSupport();
			if (!support.supported) {
				setStatus("error");
				setErrorMessage(
					support.message ??
						"串流下载 Loom 视频需要最新版桌面 Chrome 或 Edge。",
				);
				return;
			}

			await runBrowserConversion({
				url: result.downloadUrl,
				filename,
				videoName: result.videoName ?? "",
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setStatus("idle");
				return;
			}
			if (isLoomBrowserConversionAbort(err)) {
				setStatus("idle");
				return;
			}
			setStatus("error");
			setErrorMessage(
				getLoomBrowserConversionErrorMessage(err) ?? "发生意外错误，请重试。",
			);
		} finally {
			abortRef.current = null;
		}
	}, [runBrowserConversion, updateDownloadObjectUrl, url]);

	const handleDownloadAnother = useCallback(() => {
		setUrl("");
		setStatus("idle");
		setErrorMessage("");
		setConvertProgress(0);
		setLastDownloadedName("");
		setLastCompletionKind("ready");
		updateDownloadObjectUrl(null);
	}, [updateDownloadObjectUrl]);

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
			? "正在获取……"
			: status === "downloading"
				? "正在下载……"
				: status === "converting"
					? `正在下载……${convertProgress}%`
					: "下载视频";

	if (status === "success") {
		return (
			<MigrationSuccessState
				completionKind={lastCompletionKind}
				downloadedName={lastDownloadedName}
				openUrl={lastDownloadObjectUrl}
				onDownloadAnother={handleDownloadAnother}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<MigrationBanner />

			<div className="flex flex-col gap-2 sm:gap-3">
				<label htmlFor={inputId} className="text-sm font-medium text-gray-700">
					Loom 视频网址
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
					<p className="text-xs text-gray-500 text-center">正在准备 MP4……</p>
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
						<title>错误</title>
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
						<title>隐私</title>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
						/>
					</svg>
					粘贴任意公开 Loom 链接。免费下载器会在浏览器中运行。
				</div>
				<a
					href={MIGRATE_CHECKOUT_HREF}
					className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline"
				>
					使用 Cap 专业版导入 Loom 视频
					<svg
						className="w-3 h-3"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={2}
						role="img"
					>
						<title>箭头</title>
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
