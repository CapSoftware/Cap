"use client";

import { Button } from "@inflight/ui";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";

const SPEED_OPTIONS = [
	{ value: 0.25, label: "0.25x (Very Slow)" },
	{ value: 0.5, label: "0.5x (Slow)" },
	{ value: 0.75, label: "0.75x (Slightly Slow)" },
	{ value: 1.25, label: "1.25x (Slightly Fast)" },
	{ value: 1.5, label: "1.5x (Fast)" },
	{ value: 2, label: "2x (Very Fast)" },
	{ value: 3, label: "3x (Ultra Fast)" },
];

const SUPPORTED_VIDEO_FORMATS = ["mp4", "webm", "mov", "avi", "mkv"];

export const SpeedController = () => {
	const [file, setFile] = useState<File | null>(null);
	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);
	const [outputUrl, setOutputUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [selectedSpeed, setSelectedSpeed] = useState<number>(1.5);
	const [videoInfo, setVideoInfo] = useState<{
		duration: number;
		dimensions: string;
	} | null>(null);
	const [isSafari, setIsSafari] = useState(false);
	const [selectedMimeType, setSelectedMimeType] = useState<string>("");

	const fileInputRef = useRef<HTMLInputElement>(null);
	const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFile = e.target.files?.[0];
		if (selectedFile) {
			validateAndSetFile(selectedFile);
		}
	};

	const validateAndSetFile = (selectedFile: File) => {
		setError(null);
		setOutputUrl(null);
		setVideoInfo(null);

		const isVideoFile =
			selectedFile.type.startsWith("video/") ||
			SUPPORTED_VIDEO_FORMATS.some((format) =>
				selectedFile.name.toLowerCase().endsWith(`.${format}`),
			);

		if (!isVideoFile) {
			setError("Please select a valid video file.");
			trackEvent("speed_controller_invalid_file_type", {
				fileType: selectedFile.type,
			});
			return;
		}

		if (selectedFile.size > 500 * 1024 * 1024) {
			setError("File size exceeds 500MB limit.");
			trackEvent("speed_controller_file_too_large", {
				fileSize: selectedFile.size,
			});
			return;
		}

		setFile(selectedFile);
		trackEvent("speed_controller_file_selected", {
			fileSize: selectedFile.size,
			fileType: selectedFile.type,
		});

		const videoElement = document.createElement("video");
		videoElement.preload = "metadata";

		videoElement.onloadedmetadata = () => {
			URL.revokeObjectURL(videoElement.src);
			const duration = videoElement.duration;
			const dimensions = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
			setVideoInfo({ duration, dimensions });
		};

		videoElement.src = URL.createObjectURL(selectedFile);
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

	const processVideo = async () => {
		if (!file) return;

		setIsProcessing(true);
		setError(null);
		setProgress(0);

		const action = selectedSpeed < 1 ? "slowing_down" : "speeding_up";
		trackEvent(`speed_controller_${action}_started`, {
			fileSize: file.size,
			fileName: file.name,
			speedFactor: selectedSpeed,
		});

		try {
			console.log(`Starting video speed adjustment: ${selectedSpeed}x`);
			console.log(`Input file: ${file.name}, size: ${file.size} bytes`);

			const fileUrl = URL.createObjectURL(file);
			await adjustVideoSpeed(fileUrl);
			URL.revokeObjectURL(fileUrl);
		} catch (err: any) {
			console.error("Detailed processing error:", err);

			let errorMessage = "Processing failed: ";
			if (err.message) {
				errorMessage += err.message;
			} else if (typeof err === "string") {
				errorMessage += err;
			} else {
				errorMessage += "Unknown error occurred during processing";
			}

			setError(errorMessage);

			trackEvent(`speed_controller_${action}_failed`, {
				fileSize: file.size,
				fileName: file.name,
				error: err.message || "Unknown error",
				speedFactor: selectedSpeed,
			});
		} finally {
			setIsProcessing(false);
		}
	};

	const adjustVideoSpeed = async (videoUrl: string): Promise<void> => {
		return new Promise((resolve, reject) => {
			const video = document.createElement("video");
			videoRef.current = video;
			video.src = videoUrl;
			video.muted = false;

			video.oncanplay = async () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					const ctx = canvas.getContext("2d", { alpha: false });

					if (!ctx) {
						throw new Error("Failed to create canvas context");
					}

					let inputFormat = "video/webm";
					if (file?.type) {
						inputFormat = file.type;
					} else if (file?.name) {
						const extension = file.name.split(".").pop()?.toLowerCase();
						if (extension === "mp4") inputFormat = "video/mp4";
						else if (extension === "webm") inputFormat = "video/webm";
						else if (extension === "mov") inputFormat = "video/quicktime";
					}

					let mimeTypes: string[] = [];

					if (inputFormat.includes("mp4")) {
						mimeTypes = [
							"video/mp4",
							"video/webm;codecs=vp9,opus",
							"video/webm;codecs=vp8,opus",
							"video/webm;codecs=vp9",
							"video/webm;codecs=vp8",
							"video/webm",
						];
					} else {
						mimeTypes = [
							"video/webm;codecs=vp9,opus",
							"video/webm;codecs=vp8,opus",
							"video/webm;codecs=vp9",
							"video/webm;codecs=vp8",
							"video/webm",
							"video/mp4",
						];
					}

					let selectedMimeType = "";
					for (const type of mimeTypes) {
						if (MediaRecorder.isTypeSupported(type)) {
							selectedMimeType = type;
							break;
						}
					}

					if (!selectedMimeType) {
						throw new Error(
							"None of the media formats are supported by this browser",
						);
					}

					setSelectedMimeType(selectedMimeType);
					console.log(
						`Input format: ${inputFormat}, Selected output format: ${selectedMimeType}`,
					);

					let includeAudio = true;
					const supportsAudio = MediaRecorder.isTypeSupported(
						selectedMimeType +
							(selectedMimeType.includes("codecs=") ? ",opus" : ";codecs=opus"),
					);

					if (!supportsAudio) {
						console.warn(
							`Selected MIME type does not support audio: ${selectedMimeType}`,
						);
						includeAudio = false;
					}

					const stream = canvas.captureStream(60);

					video.muted = false;
					if (includeAudio) {
						try {
							const audioContext = new AudioContext();
							const source = audioContext.createMediaElementSource(video);
							const destination = audioContext.createMediaStreamDestination();
							source.connect(destination);

							destination.stream.getAudioTracks().forEach((track) => {
								stream.addTrack(track);
							});
						} catch (audioErr) {
							console.warn("Could not add audio track", audioErr);
						}
					}

					const recorder = new MediaRecorder(stream, {
						mimeType: selectedMimeType,
						videoBitsPerSecond: 5000000,
					});
					mediaRecorderRef.current = recorder;
					recordedChunksRef.current = [];

					recorder.ondataavailable = (e) => {
						if (e.data.size > 0) {
							recordedChunksRef.current.push(e.data);
						}
					};

					recorder.onstop = () => {
						const chunks = recordedChunksRef.current;
						const blob = new Blob(chunks, {
							type: selectedMimeType.split(";")[0],
						});
						const url = URL.createObjectURL(blob);

						setOutputUrl(url);

						trackEvent(
							`speed_controller_${
								selectedSpeed < 1 ? "slowing_down" : "speeding_up"
							}_completed`,
							{
								fileSize: file?.size,
								fileName: file?.name,
								outputSize: blob.size,
								speedFactor: selectedSpeed,
							},
						);

						videoRef.current = null;
						mediaRecorderRef.current = null;
						resolve();
					};

					recorder.start(1000);

					video.playbackRate = selectedSpeed;

					const finishProcessing = () => {
						if (recorder.state === "recording") {
							recorder.stop();
						}
						setProgress(100);
						cancelAnimationFrame(animationFrameId);
					};

					const totalDuration = video.duration / selectedSpeed;
					let lastProgress = 0;
					let stuckCounter = 0;
					let isFrameStuck = false;
					let lastFrameTime = 0;
					let animationFrameId: number;

					const renderFrame = () => {
						if (video.readyState >= 2) {
							const currentTime = video.currentTime;
							const currentProgress = (currentTime / video.duration) * 100;

							if (currentTime !== lastFrameTime) {
								ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
								lastFrameTime = currentTime;
								isFrameStuck = false;
							} else {
								isFrameStuck = true;
							}

							if (Math.abs(currentProgress - lastProgress) < 0.1) {
								stuckCounter++;
								if (stuckCounter > 180 && currentProgress > 95) {
									console.log(
										"Progress appears to be stuck, forcing completion",
									);
									finishProcessing();
									return;
								}
							} else {
								stuckCounter = 0;
								lastProgress = currentProgress;
							}

							setProgress(Math.min(Math.round(currentProgress), 99));
						}

						if (video.ended || (isFrameStuck && stuckCounter > 300)) {
							finishProcessing();
						} else {
							animationFrameId = requestAnimationFrame(renderFrame);
						}
					};

					video
						.play()
						.then(() => {
							animationFrameId = requestAnimationFrame(renderFrame);
						})
						.catch((err) => {
							console.error("Error playing video:", err);
							reject(err);
						});

					const safetyTimeout = setTimeout(
						() => {
							if (recorder.state === "recording") {
								console.log("Safety timeout reached, forcing completion");
								finishProcessing();
							}
						},
						totalDuration * 1000 + 5000,
					);

					video.onended = () => {
						clearTimeout(safetyTimeout);
						setTimeout(() => {
							finishProcessing();
						}, 500);
					};
				} catch (err) {
					reject(err);
				}
			};

			video.onerror = () => {
				reject(new Error("Error loading video"));
			};
		});
	};

	const handleDownload = () => {
		if (!outputUrl || !file) return;

		const dotIndex = file.name.lastIndexOf(".");
		const baseName =
			dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;

		const chunks = recordedChunksRef.current;
		let extension = "webm";

		if (chunks.length > 0) {
			const firstChunk = chunks[0];
			if (firstChunk) {
				const type = firstChunk.type;
				if (type.includes("mp4")) {
					extension = "mp4";
				} else if (type.includes("webm")) {
					extension = "webm";
				} else if (type.includes("quicktime") || type.includes("mov")) {
					extension = "mov";
				}
			}
		} else {
			if (selectedMimeType.includes("mp4")) {
				extension = "mp4";
			} else if (selectedMimeType.includes("webm")) {
				extension = "webm";
			} else if (
				selectedMimeType.includes("quicktime") ||
				selectedMimeType.includes("mov")
			) {
				extension = "mov";
			}
		}

		const downloadFileName = `${baseName}_${selectedSpeed}x.${extension}`;

		trackEvent(`speed_controller_download_clicked`, {
			fileName: downloadFileName,
			speedFactor: selectedSpeed,
		});

		const link = document.createElement("a");
		link.href = outputUrl;
		link.download = downloadFileName;
		link.click();
	};

	const resetController = () => {
		if (outputUrl) {
			URL.revokeObjectURL(outputUrl);
		}

		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state !== "inactive"
		) {
			mediaRecorderRef.current.stop();
		}

		if (videoRef.current) {
			videoRef.current.pause();
			videoRef.current.src = "";
		}

		setFile(null);
		setOutputUrl(null);
		setProgress(0);
		setError(null);
		setVideoInfo(null);
		recordedChunksRef.current = [];

		trackEvent(`speed_controller_reset`);

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const formatDuration = (seconds: number) => {
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
	};

	const getEstimatedOutputDuration = () => {
		if (!videoInfo) return null;
		const estimatedDuration = videoInfo.duration / selectedSpeed;
		return formatDuration(estimatedDuration);
	};

	useEffect(() => {
		const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(
			navigator.userAgent,
		);
		setIsSafari(isSafariBrowser);
	}, []);

	return (
		<div className="w-full">
			<h2 className="text-2xl font-semibold text-center mb-6">
				{selectedSpeed < 1 ? "Slow Down" : "Speed Up"} Your Video
			</h2>

			<div className="mb-6">
				<label className="block text-sm font-medium text-gray-700 mb-2">
					Select Speed
				</label>
				<div className="flex flex-wrap gap-2 justify-center">
					{SPEED_OPTIONS.map((option) => (
						<button
							key={option.value}
							onClick={() => setSelectedSpeed(option.value)}
							className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
								selectedSpeed === option.value
									? "bg-blue-600 text-white"
									: "bg-gray-200 text-gray-800 hover:bg-gray-300"
							}`}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>

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
					accept="video/*"
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
								Drag and drop your video file here
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
							{videoInfo && (
								<div className="mt-3 text-sm text-gray-600">
									<p>Duration: {formatDuration(videoInfo.duration)}</p>
									<p>Resolution: {videoInfo.dimensions}</p>
									<p className="mt-2 font-medium">
										Estimated output duration: {getEstimatedOutputDuration()}
									</p>
								</div>
							)}
						</>
					)}
				</div>
			</div>

			{error && (
				<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
					{error}
				</div>
			)}

			{isProcessing && (
				<div className="mb-6">
					<p className="text-center text-gray-700 mb-2">
						Processing... {progress}%
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
						Video {selectedSpeed < 1 ? "slowed down" : "sped up"} successfully!
					</p>
					<video
						ref={videoPreviewRef}
						src={outputUrl}
						controls
						className="w-full rounded-lg mb-4 bg-black"
						style={{ maxHeight: "400px" }}
					></video>
					<div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
						<Button
							variant="primary"
							onClick={handleDownload}
							className="w-full"
						>
							Download {selectedSpeed}x Video
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
				{file && !isProcessing && !outputUrl && (
					<Button
						variant="primary"
						onClick={processVideo}
						disabled={isProcessing}
						className="w-full"
					>
						{selectedSpeed < 1 ? "Slow Down" : "Speed Up"} Video (
						{selectedSpeed}x)
					</Button>
				)}

				{(file || outputUrl) && (
					<Button
						variant="white"
						onClick={resetController}
						disabled={isProcessing}
						className="w-full"
					>
						{outputUrl ? "Process Another Video" : "Reset"}
					</Button>
				)}
			</div>

			<div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
				<p>
					This tool works entirely in your browser. Your videos are never
					uploaded to any server.
				</p>
				<p className="mt-1">
					Powered by modern browser APIs like MediaRecorder and Canvas for
					efficient video processing.
				</p>
				{isSafari && (
					<div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
						<p>
							<strong>Safari Compatibility Notice:</strong> Safari has limited
							support for some video processing features. For best results,
							consider using Chrome or Firefox.
						</p>
					</div>
				)}
			</div>
		</div>
	);
};
