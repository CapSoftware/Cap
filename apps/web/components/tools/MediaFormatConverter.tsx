"use client";

import { Button } from "@cap/ui";
import * as MediaParser from "@remotion/media-parser";
import type { WebCodecsController } from "@remotion/webcodecs";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";

export const SUPPORTED_FORMATS = {
	video: ["mp4", "webm", "mov", "avi", "mkv"],
	audio: ["mp3"],
	image: ["gif"],
};

export const FORMAT_GROUPS = {
	video: ["mp4", "webm", "mov", "avi", "mkv"],
	audio: ["mp3"],
	image: ["gif"],
};

export const CONVERSION_CONFIGS: Record<
	string,
	{
		acceptType: string;
		outputType: string;
		title: (source: string, target: string) => string;
		description: (source: string, target: string) => string;
	}
> = {
	"webm-to-mp4": {
		acceptType: "video/webm",
		outputType: "video/mp4",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
	},
	"mp4-to-webm": {
		acceptType: "video/mp4",
		outputType: "video/webm",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
	},
	"mov-to-mp4": {
		acceptType: "video/quicktime",
		outputType: "video/mp4",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
	},
	"avi-to-mp4": {
		acceptType: "video/x-msvideo",
		outputType: "video/mp4",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
	},
	"mkv-to-mp4": {
		acceptType: "video/x-matroska",
		outputType: "video/mp4",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
	},
	"mp4-to-mp3": {
		acceptType: "video/mp4",
		outputType: "audio/mp3",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Extract audio from ${source.toUpperCase()} videos and save as ${target.toUpperCase()} files`,
	},
	"mp4-to-gif": {
		acceptType: "video/mp4",
		outputType: "image/gif",
		title: (source, target) =>
			`${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
		description: (source, target) =>
			`Convert ${source.toUpperCase()} videos to animated ${target.toUpperCase()} images`,
	},
};

export const parseFormats = (
	conversionPath: string,
): { sourceFormat: string; targetFormat: string } => {
	const parts = conversionPath.split("-to-");
	return {
		sourceFormat: parts[0] || "webm",
		targetFormat: parts[1] || "mp4",
	};
};

export const getMimeType = (format: string): string => {
	switch (format) {
		case "mp4":
			return "video/mp4";
		case "webm":
			return "video/webm";
		case "mov":
			return "video/quicktime";
		case "avi":
			return "video/x-msvideo";
		case "mkv":
			return "video/x-matroska";
		case "mp3":
			return "audio/mp3";
		case "gif":
			return "image/gif";
		default:
			return "";
	}
};

export const getAcceptAttribute = (format: string): string => {
	switch (format) {
		case "mp4":
			return "video/mp4";
		case "webm":
			return "video/webm";
		case "mov":
			return "video/quicktime";
		case "avi":
			return "video/x-msvideo";
		case "mkv":
			return "video/x-matroska";
		case "mp3":
			return "audio/mp3";
		case "gif":
			return "image/gif";
		default:
			return "";
	}
};

interface MediaFormatConverterProps {
	initialConversionPath: string;
}

export const MediaFormatConverter = ({
	initialConversionPath,
}: MediaFormatConverterProps) => {
	const router = useRouter();
	const pathname = usePathname() || "";

	const { sourceFormat = "webm", targetFormat = "mp4" } = parseFormats(
		initialConversionPath,
	);

	const [file, setFile] = useState<File | null>(null);
	const [isConverting, setIsConverting] = useState(false);
	const [progress, setProgress] = useState(0);
	const [outputUrl, setOutputUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mediaEngineLoaded, setMediaEngineLoaded] = useState(true);
	const [isDragging, setIsDragging] = useState(false);
	const [currentSourceFormat, setCurrentSourceFormat] = useState(sourceFormat);
	const [currentTargetFormat, setCurrentTargetFormat] = useState(targetFormat);
	const [_supportedFormats, setSupportedFormats] = useState<string[]>([
		"mp4",
		"webm",
	]);
	const [isSafari, setIsSafari] = useState(false);
	const [isFirefox, setIsFirefox] = useState(false);

	const [gifQuality, setGifQuality] = useState(18);
	const [gifFps, setGifFps] = useState(15);
	const [gifMaxWidth, setGifMaxWidth] = useState(1280);
	const [gifDithering, setGifDithering] = useState(false);

	const conversionPath = `${currentSourceFormat}-to-${currentTargetFormat}`;
	const config = CONVERSION_CONFIGS[conversionPath];

	const fileInputRef = useRef<HTMLInputElement>(null);
	const recordedChunksRef = useRef<Blob[]>([]);
	const parserControllerRef = useRef<{ abort: () => void } | null>(null);

	useEffect(() => {
		if (
			sourceFormat !== currentSourceFormat ||
			targetFormat !== currentTargetFormat
		) {
			try {
				const basePath = pathname.split("/").slice(0, -1).join("/");
				const newPath = `${basePath}/${currentSourceFormat}-to-${currentTargetFormat}`;
				router.push(newPath);
			} catch (error) {
				console.error("Error updating URL:", error);
			}
		}
	}, [
		currentSourceFormat,
		currentTargetFormat,
		pathname,
		router,
		sourceFormat,
		targetFormat,
	]);

	useEffect(() => {
		const checkSupport = async () => {
			if (MediaRecorder.isTypeSupported("video/webm")) {
				setSupportedFormats((prev) => [...prev, "webm"]);
			}

			trackEvent(`${conversionPath}_tool_loaded`);
		};

		checkSupport();
	}, [conversionPath]);

	useEffect(() => {
		const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(
			navigator.userAgent,
		);
		setIsSafari(isSafariBrowser);

		const isFirefoxBrowser = navigator.userAgent.indexOf("Firefox") !== -1;
		setIsFirefox(isFirefoxBrowser);
	}, []);

	useEffect(() => {
		const loadRemotionModules = async () => {
			try {
				const _parser = await import("@remotion/media-parser");
				setMediaEngineLoaded(true);
			} catch (error) {
				console.error("Failed to load Remotion modules:", error);
				setMediaEngineLoaded(false);
				setError(
					"Failed to load media conversion engine. Please try again later.",
				);
			}
		};

		loadRemotionModules();
	}, []);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFile = e.target.files?.[0];
		if (selectedFile) {
			validateAndSetFile(selectedFile);
		}
	};

	const validateAndSetFile = (selectedFile: File) => {
		setError(null);
		setOutputUrl(null);

		const expectedMimeType = getMimeType(currentSourceFormat);

		let isValidType = false;

		if (currentSourceFormat === "mov") {
			isValidType =
				selectedFile.type === "video/quicktime" ||
				selectedFile.type === "video/mov" ||
				selectedFile.name.toLowerCase().endsWith(".mov");
		} else if (currentSourceFormat === "mkv") {
			isValidType =
				selectedFile.type === "video/x-matroska" ||
				selectedFile.name.toLowerCase().endsWith(".mkv");
		} else if (currentSourceFormat === "avi") {
			isValidType =
				selectedFile.type === "video/x-msvideo" ||
				selectedFile.type === "video/avi" ||
				selectedFile.name.toLowerCase().endsWith(".avi");
		} else {
			isValidType =
				selectedFile.type === expectedMimeType ||
				selectedFile.type.includes(currentSourceFormat) ||
				selectedFile.name.toLowerCase().endsWith(`.${currentSourceFormat}`);
		}

		if (!isValidType) {
			setError(`Please select a ${currentSourceFormat.toUpperCase()} file.`);
			trackEvent(`${conversionPath}_invalid_file_type`, {
				fileType: selectedFile.type,
			});
			return;
		}

		if (selectedFile.size > 500 * 1024 * 1024) {
			setError("File size exceeds 500MB limit.");
			trackEvent(`${conversionPath}_file_too_large`, {
				fileSize: selectedFile.size,
			});
			return;
		}

		setFile(selectedFile);
		trackEvent(`${conversionPath}_file_selected`, {
			fileSize: selectedFile.size,
		});
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);

		const droppedFile = e.dataTransfer.files[0];
		if (droppedFile) {
			validateAndSetFile(droppedFile);
		}
	};

	const convertFile = async () => {
		if (!file || !mediaEngineLoaded || !config) return;

		setIsConverting(true);
		setError(null);
		setProgress(0);

		if (parserControllerRef.current) {
			parserControllerRef.current.abort();
		}
		parserControllerRef.current = { abort: () => {} };

		trackEvent(`${conversionPath}_conversion_started`, {
			fileSize: file.size,
			fileName: file.name,
		});

		try {
			console.log(`Starting conversion: ${conversionPath}`);
			console.log(`Input file: ${file.name}, size: ${file.size} bytes`);

			if (currentTargetFormat === "mp3" && currentSourceFormat === "mp4") {
				await extractAudioFromVideo(file);
			} else if (
				currentTargetFormat === "gif" &&
				currentSourceFormat === "mp4"
			) {
				await convertVideoToGif(file);
			} else {
				await convertVideoFormat(file);
			}
		} catch (err: any) {
			console.error("Detailed conversion error:", err);

			if (MediaParser.hasBeenAborted?.(err)) {
				setError("Conversion was cancelled");
			} else {
				let errorMessage = "Conversion failed: ";
				if (err.message) {
					errorMessage += err.message;
				} else if (typeof err === "string") {
					errorMessage += err;
				} else {
					errorMessage += "Unknown error occurred during conversion";
				}

				setError(errorMessage);

				trackEvent(`${conversionPath}_conversion_failed`, {
					fileSize: file.size,
					fileName: file.name,
					error: err.message || "Unknown error",
				});
			}
		} finally {
			setIsConverting(false);
			parserControllerRef.current = null;
		}
	};

	const extractAudioFromVideo = async (inputFile: File): Promise<void> => {
		try {
			const parser = await import("@remotion/media-parser");
			const webcodecs = await import("@remotion/webcodecs");

			const _handleProgress = (progressEvent: { progress: number }) => {
				setProgress(Math.min(Math.round(progressEvent.progress * 100), 99));
			};

			const controller = parser.mediaParserController
				? parser.mediaParserController()
				: null;
			parserControllerRef.current = controller;

			const result = await webcodecs.convertMedia({
				src: inputFile,
				container: "wav",
				onProgress: ({ overallProgress }) => {
					if (overallProgress !== null) {
						setProgress(Math.min(Math.round(overallProgress * 100), 99));
					}
				},
				controller: controller as unknown as WebCodecsController,
			});

			const blob = await result.save();
			const url = URL.createObjectURL(blob);
			setOutputUrl(url);
			setProgress(100);

			trackEvent(`${conversionPath}_conversion_completed`, {
				fileSize: file?.size,
				fileName: file?.name,
				outputSize: blob.size,
			});
		} catch (error) {
			console.error("Error extracting audio:", error);
			throw error;
		}
	};

	const convertVideoToGif = async (inputFile: File): Promise<void> => {
		try {
			const parser = await import("@remotion/media-parser");
			const _webcodecs = await import("@remotion/webcodecs");

			const _onProgress = ({
				overallProgress,
			}: {
				overallProgress: number | null;
			}) => {
				if (overallProgress !== null) {
					setProgress(Math.min(Math.round(overallProgress * 100), 99));
				}
			};

			const controller = parser.mediaParserController
				? parser.mediaParserController()
				: null;
			parserControllerRef.current = controller;

			console.log(`Starting video to GIF conversion`);
			console.log(
				`Input file: ${inputFile.name}, size: ${inputFile.size} bytes`,
			);

			const isCanvasSupported = !!document
				.createElement("canvas")
				.getContext("2d");
			if (!isCanvasSupported) {
				throw new Error(
					"Your browser doesn't support canvas operations required for GIF conversion",
				);
			}

			const metadata = await parser.parseMedia({
				src: inputFile,
				fields: {
					durationInSeconds: true,
					dimensions: true,
					videoCodec: true,
				},
			});

			console.log("Video metadata for GIF conversion:", metadata);

			const originalWidth = metadata.dimensions?.width || 1920;
			const originalHeight = metadata.dimensions?.height || 1080;
			const maxWidth = gifMaxWidth;
			const scale = originalWidth > maxWidth ? maxWidth / originalWidth : 1;
			const targetWidth = Math.floor(originalWidth * scale);
			const targetHeight = Math.floor(originalHeight * scale);

			const GifModule = await import("gif.js");
			const GIF = GifModule.default;

			const videoElement = document.createElement("video");
			videoElement.muted = true;
			videoElement.playsInline = true;
			videoElement.src = URL.createObjectURL(inputFile);

			await new Promise((resolve) => {
				videoElement.onloadedmetadata = () => resolve(null);
			});

			const videoDuration = videoElement.duration;
			const fps = gifFps;
			const frameCount = Math.min(Math.floor(videoDuration * fps), gifFps * 15);
			const frameDelay = 1000 / fps;

			const canvas = document.createElement("canvas");
			canvas.width = targetWidth;
			canvas.height = targetHeight;
			const ctx = canvas.getContext("2d");

			if (!ctx) {
				throw new Error("Failed to get canvas context");
			}

			const gifEncoder = new GIF({
				workers: 2,
				quality: gifQuality,
				width: targetWidth,
				height: targetHeight,
				workerScript: "/gif.worker.js",
				dither: gifDithering,
			});

			const captureFrame = async (time: number): Promise<void> => {
				return new Promise((resolve) => {
					videoElement.currentTime = time;
					videoElement.onseeked = () => {
						ctx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
						gifEncoder.addFrame(canvas, { delay: frameDelay, copy: true });
						resolve();
					};
				});
			};

			gifEncoder.on("progress", (progress: number) => {
				setProgress(Math.min(Math.round(progress * 90 + 5), 95));
			});

			await videoElement.play();
			videoElement.pause();

			setProgress(5);

			const frameInterval = videoDuration / frameCount;
			for (let i = 0; i < frameCount; i++) {
				const frameTime = i * frameInterval;
				await captureFrame(frameTime);

				const captureProgress = (i / frameCount) * 45;
				setProgress(Math.min(Math.round(5 + captureProgress), 50));
			}

			setProgress(50);

			const gifBlob = await new Promise<Blob>((resolve) => {
				gifEncoder.on("finished", (blob: Blob) => {
					resolve(blob);
				});
				gifEncoder.render();
			});

			URL.revokeObjectURL(videoElement.src);

			const gifUrl = URL.createObjectURL(gifBlob);
			setOutputUrl(gifUrl);
			setProgress(100);

			recordedChunksRef.current = [gifBlob];

			trackEvent(`${conversionPath}_conversion_completed`, {
				fileSize: file?.size,
				fileName: file?.name,
				outputSize: gifBlob.size,
			});
		} catch (error) {
			console.error("Error converting video to GIF:", error);

			if (MediaParser.hasBeenAborted?.(error)) {
				setError("Conversion was cancelled");
			} else {
				let errorMessage = "GIF conversion failed: ";

				if (error instanceof Error) {
					errorMessage += error.message;
				} else if (typeof error === "string") {
					errorMessage += error;
				} else {
					errorMessage += "Unknown error occurred during conversion";
				}

				setError(errorMessage);
			}

			throw error;
		}
	};

	const convertVideoFormat = async (inputFile: File): Promise<void> => {
		try {
			const parser = await import("@remotion/media-parser");
			const webcodecs = await import("@remotion/webcodecs");

			const onProgress = ({
				overallProgress,
			}: {
				overallProgress: number | null;
			}) => {
				if (overallProgress !== null) {
					setProgress(Math.min(Math.round(overallProgress * 100), 99));
				}
			};

			const controller = parser.mediaParserController
				? parser.mediaParserController()
				: null;
			parserControllerRef.current = controller;

			console.log(`Starting conversion with Remotion: ${conversionPath}`);
			console.log(
				`Input file: ${inputFile.name}, size: ${inputFile.size} bytes`,
			);

			const canUseWebCodecs =
				typeof VideoDecoder !== "undefined" &&
				typeof AudioDecoder !== "undefined" &&
				typeof ArrayBuffer.prototype.resize === "function";

			if (!canUseWebCodecs) {
				throw new Error(
					"Your browser doesn't support WebCodecs. Try using Chrome or Edge.",
				);
			}

			const metadata = await parser.parseMedia({
				src: inputFile,
				fields: {
					durationInSeconds: true,
					dimensions: true,
					videoCodec: true,
				},
			});

			console.log("Video metadata:", metadata);

			const outputContainer = currentTargetFormat === "webm" ? "webm" : "mp4";

			let videoCodec;
			if (outputContainer === "webm") {
				videoCodec = "vp8";
			} else {
				videoCodec = "h264";
			}

			const result = await webcodecs.convertMedia({
				src: inputFile,
				container: outputContainer as any,
				videoCodec: videoCodec as any,
				onProgress,
				controller: controller as unknown as WebCodecsController,
				expectedDurationInSeconds: metadata.durationInSeconds || undefined,
			});

			const blob = await result.save();
			const url = URL.createObjectURL(blob);

			setOutputUrl(url);
			setProgress(100);

			recordedChunksRef.current = [blob];

			trackEvent(`${conversionPath}_conversion_completed`, {
				fileSize: file?.size,
				fileName: file?.name,
				outputSize: blob.size,
			});
		} catch (error) {
			console.error("Error converting video format:", error);

			if (MediaParser.hasBeenAborted?.(error)) {
				setError("Conversion was cancelled");
			} else {
				let errorMessage = "Conversion failed: ";

				if (error instanceof Error) {
					errorMessage += error.message;
				} else if (typeof error === "string") {
					errorMessage += error;
				} else {
					errorMessage += "Unknown error occurred during conversion";
				}

				setError(errorMessage);
			}

			throw error;
		}
	};

	const handleDownload = () => {
		if (!outputUrl || !file) return;

		let actualExtension = currentTargetFormat;

		if (recordedChunksRef.current.length > 0) {
			const firstChunk = recordedChunksRef.current[0];
			if (firstChunk) {
				const type = firstChunk.type;

				if (type.includes("mp4")) {
					actualExtension = "mp4";
				} else if (type.includes("webm")) {
					actualExtension = "webm";
				} else if (type.includes("mp3")) {
					actualExtension = "mp3";
				} else if (type.includes("gif")) {
					actualExtension = "gif";
				}
			}
		}

		const fileExtension = `.${currentSourceFormat}`;
		const newExtension = `.${actualExtension}`;
		const downloadFileName = file.name.replace(
			new RegExp(`${fileExtension}$`),
			newExtension,
		);

		trackEvent(`${conversionPath}_download_clicked`, {
			fileName: downloadFileName,
		});

		const link = document.createElement("a");
		link.href = outputUrl;
		link.download = downloadFileName;
		link.click();
	};

	const resetConverter = () => {
		if (outputUrl) {
			URL.revokeObjectURL(outputUrl);
		}

		if (parserControllerRef.current) {
			parserControllerRef.current.abort();
			parserControllerRef.current = null;
		}

		setFile(null);
		setOutputUrl(null);
		setProgress(0);
		setError(null);
		recordedChunksRef.current = [];

		trackEvent(`${conversionPath}_reset`);

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const getValidSourceFormats = () => {
		return Object.keys(CONVERSION_CONFIGS)
			.map((path) => {
				const { sourceFormat } = parseFormats(path);
				return sourceFormat;
			})
			.filter((value, index, self) => self.indexOf(value) === index);
	};

	const getValidTargetFormats = (source: string) => {
		return Object.keys(CONVERSION_CONFIGS)
			.filter((path) => path.startsWith(`${source}-to-`))
			.map((path) => {
				const { targetFormat } = parseFormats(path);
				return targetFormat;
			});
	};

	const validSourceFormats = getValidSourceFormats();
	const validTargetFormats = getValidTargetFormats(currentSourceFormat);

	const handleSourceFormatChange = (newSourceFormat: string) => {
		setCurrentSourceFormat(newSourceFormat);
		const newValidTargets = getValidTargetFormats(newSourceFormat);
		if (
			newValidTargets.length > 0 &&
			!newValidTargets.includes(currentTargetFormat)
		) {
			if (newValidTargets[0]) {
				setCurrentTargetFormat(newValidTargets[0]);
			}
		}
		resetConverter();
	};

	const handleTargetFormatChange = (newTargetFormat: string) => {
		setCurrentTargetFormat(newTargetFormat);
		resetConverter();
	};

	if (!config) {
		return (
			<div className="p-6 bg-red-50 border border-red-200 rounded-lg text-red-600">
				<p>Unsupported conversion: {conversionPath}</p>
				<Link
					href="/tools/convert"
					className="mt-4 inline-flex items-center text-blue-600 hover:text-blue-800"
				>
					← Back to Conversion Tools
				</Link>
			</div>
		);
	}

	return (
		<div className="w-full">
			<h2 className="text-2xl font-semibold text-center mb-6">
				{config.title(currentSourceFormat, currentTargetFormat)}
			</h2>

			<div className="w-full mb-6">
				<div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-2">
					<div className="w-full sm:w-auto flex flex-col sm:flex-row items-center">
						<span className="w-full sm:w-auto text-center sm:text-left mb-2 sm:mb-0 sm:mr-2 text-gray-700 font-medium">
							From:
						</span>
						<div className="flex flex-wrap justify-center gap-2 w-full">
							{validSourceFormats.map((format) => (
								<Link
									key={format}
									href={`/tools/convert/${format}-to-${
										getValidTargetFormats(format).includes(currentTargetFormat)
											? currentTargetFormat
											: getValidTargetFormats(format)[0]
									}`}
									onClick={(e) => {
										e.preventDefault();
										handleSourceFormatChange(format);
									}}
									className={`px-3 py-1.5 rounded-md text-sm font-medium text-center min-w-[60px] ${
										currentSourceFormat === format
											? "bg-blue-600 text-white"
											: "bg-gray-200 text-gray-800 hover:bg-gray-300"
									}`}
									aria-label={`Convert from ${format.toUpperCase()} format`}
								>
									{format.toUpperCase()}
								</Link>
							))}
						</div>
					</div>

					<span className="hidden sm:block mx-2 text-gray-400">→</span>
					<div className="w-full sm:hidden flex justify-center my-2">
						<span className="text-gray-400 text-xl">↓</span>
					</div>

					<div className="w-full sm:w-auto flex flex-col sm:flex-row items-center">
						<span className="w-full sm:w-auto text-center sm:text-left mb-2 sm:mb-0 sm:mr-2 text-gray-700 font-medium">
							To:
						</span>
						<div className="flex flex-wrap justify-center gap-2 w-full">
							{validTargetFormats.map((format) => (
								<Link
									key={format}
									href={`/tools/convert/${currentSourceFormat}-to-${format}`}
									onClick={(e) => {
										e.preventDefault();
										handleTargetFormatChange(format);
									}}
									className={`px-3 py-1.5 rounded-md text-sm font-medium text-center min-w-[60px] ${
										currentTargetFormat === format
											? "bg-blue-600 text-white"
											: "bg-gray-200 text-gray-800 hover:bg-gray-300"
									}`}
									aria-label={`Convert to ${format.toUpperCase()} format`}
								>
									{format.toUpperCase()}
								</Link>
							))}
						</div>
					</div>
				</div>
			</div>

			{currentTargetFormat === "gif" && (
				<div className="mb-6 border border-gray-200 rounded-lg p-4">
					<h3 className="text-lg font-medium mb-3">GIF Settings</h3>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Quality (Lower is better)
							</label>
							<div className="flex items-center">
								<input
									type="range"
									min="1"
									max="20"
									value={gifQuality}
									onChange={(e) => setGifQuality(parseInt(e.target.value, 10))}
									className="w-full"
								/>
								<span className="ml-2 text-sm w-8 text-gray-600">
									{gifQuality}
								</span>
							</div>
							<p className="text-xs text-gray-500 mt-1">
								Lower values produce higher quality GIFs but larger file sizes
							</p>
						</div>
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Frames Per Second
							</label>
							<div className="flex items-center">
								<input
									type="range"
									min="5"
									max="30"
									value={gifFps}
									onChange={(e) => setGifFps(parseInt(e.target.value, 10))}
									className="w-full"
								/>
								<span className="ml-2 text-sm w-8 text-gray-600">{gifFps}</span>
							</div>
							<p className="text-xs text-gray-500 mt-1">
								Higher values create smoother animations but larger files
							</p>
						</div>
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Max Width (px)
							</label>
							<div className="flex items-center">
								<input
									type="range"
									min="240"
									max="1280"
									step="80"
									value={gifMaxWidth}
									onChange={(e) => setGifMaxWidth(parseInt(e.target.value, 10))}
									className="w-full"
								/>
								<span className="ml-2 text-sm w-10 text-gray-600">
									{gifMaxWidth}
								</span>
							</div>
							<p className="text-xs text-gray-500 mt-1">
								Larger sizes give higher resolution but increase file size
							</p>
						</div>
						<div>
							<label className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
								<input
									type="checkbox"
									checked={gifDithering}
									onChange={(e) => setGifDithering(e.target.checked)}
									className="rounded mr-2"
								/>
								Enable Dithering
							</label>
							<p className="text-xs text-gray-500 mt-1">
								Dithering can improve color appearance but may introduce noise
							</p>
						</div>
					</div>
				</div>
			)}

			<div
				className={`border-2 border-dashed rounded-lg p-8 mb-6 flex flex-col items-center justify-center cursor-pointer transition-colors ${
					isDragging
						? "border-blue-500 bg-blue-50"
						: "border-gray-300 hover:border-blue-400"
				}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				onClick={() => fileInputRef.current?.click()}
				style={{ minHeight: "200px" }}
			>
				<input
					type="file"
					accept={getAcceptAttribute(currentSourceFormat)}
					className="hidden"
					onChange={handleFileChange}
					ref={fileInputRef}
				/>

				<div className="text-center">
					{!file ? (
						<>
							<svg
								className="mx-auto h-12 w-12 text-gray-400 mb-3"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
								/>
							</svg>
							<p className="text-lg font-medium text-gray-700">
								Drag and drop your {currentSourceFormat.toUpperCase()} file here
							</p>
							<p className="text-sm text-gray-500 mt-1">
								or click to browse (max 500MB)
							</p>
						</>
					) : (
						<>
							<svg
								className="mx-auto h-12 w-12 text-green-500 mb-3"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M5 13l4 4L19 7"
								/>
							</svg>
							<p className="text-lg font-medium text-gray-700">{file.name}</p>
							<p className="text-sm text-gray-500 mt-1">
								{(file.size / (1024 * 1024)).toFixed(2)} MB
							</p>
						</>
					)}
				</div>
			</div>

			{error && (
				<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
					{error}
				</div>
			)}

			{isConverting && (
				<div className="mb-6">
					<p className="text-center text-gray-700 mb-2">
						Converting... {progress}%
					</p>
					<div className="w-full bg-gray-200 rounded-full h-2">
						<div
							className="bg-blue-600 h-2 rounded-full transition-all"
							style={{ width: `${progress}%` }}
						></div>
					</div>
				</div>
			)}

			{outputUrl && (
				<div className="mb-6 p-5 bg-green-50 border border-green-200 rounded-lg">
					<p className="text-green-700 font-medium mb-3">
						Conversion complete!
					</p>
					{config.outputType.startsWith("video/") && (
						<video
							src={outputUrl}
							controls
							className="w-full rounded-lg mb-4 bg-black"
							style={{ maxHeight: "300px" }}
						></video>
					)}
					{config.outputType.startsWith("audio/") && (
						<audio
							src={outputUrl}
							controls
							className="w-full rounded-lg mb-4"
						></audio>
					)}
					{config.outputType.startsWith("image/") && (
						<img
							src={outputUrl}
							alt="Converted GIF"
							className="max-w-full rounded-lg mb-4 mx-auto"
							style={{ maxHeight: "300px" }}
						/>
					)}
					<div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
						<Button
							variant="primary"
							onClick={handleDownload}
							className="w-full"
						>
							Download {currentTargetFormat.toUpperCase()}
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
				{file && !isConverting && !outputUrl && (
					<Button
						variant="primary"
						onClick={convertFile}
						disabled={!mediaEngineLoaded || isConverting}
						className="w-full"
					>
						Convert to {currentTargetFormat.toUpperCase()}
					</Button>
				)}

				{(file || outputUrl) && (
					<Button
						variant="white"
						onClick={resetConverter}
						disabled={isConverting}
						className="w-full"
					>
						{outputUrl ? "Convert Another File" : "Reset"}
					</Button>
				)}
			</div>

			<div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
				<p>
					This converter works entirely in your browser. Your files are never
					uploaded to any server.
				</p>
				{isSafari && (
					<div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
						<p>
							<strong>Safari Compatibility Notice:</strong> Safari has limited
							support for some media conversion features. For best results,
							consider using Chrome or Firefox.
						</p>
					</div>
				)}
				{isFirefox &&
					currentSourceFormat === "webm" &&
					currentTargetFormat === "mp4" && (
						<div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
							<p>
								<strong>Firefox Compatibility Notice:</strong> Firefox doesn't
								fully support converting WebM to MP4. The file will be encoded
								using WebM container format. For best results, try using Chrome.
							</p>
						</div>
					)}
				{currentTargetFormat === "gif" && (
					<div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700">
						<p>
							<strong>GIF Conversion:</strong> Converting to GIF format may take
							some time and result in larger file sizes. For high-quality
							results with smaller files, consider using the WebM or MP4 format
							instead.
						</p>
					</div>
				)}
			</div>
		</div>
	);
};
