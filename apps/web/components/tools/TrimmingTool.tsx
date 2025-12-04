"use client";

import { Button } from "@cap/ui";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";

const SUPPORTED_VIDEO_FORMATS = ["mp4", "webm", "mov", "avi", "mkv"];

export const TrimmingTool = () => {
	const [fileState, setFileState] = useState<{
		file: File | null;
		isLoading: boolean;
		videoSrc: string | null;
		error: string | null;
	}>({
		file: null,
		isLoading: false,
		videoSrc: null,
		error: null,
	});

	const [videoState, setVideoState] = useState<{
		info: { duration: number; dimensions: string } | null;
		currentTime: number;
		selectedMimeType: string;
		isSafari: boolean;
	}>({
		info: null,
		currentTime: 0,
		selectedMimeType: "",
		isSafari: false,
	});

	const [trimState, setTrimState] = useState<{
		startTime: number;
		endTime: number;
	}>({
		startTime: 0,
		endTime: 0,
	});

	const [processingState, setProcessingState] = useState<{
		isProcessing: boolean;
		progress: number;
		outputUrl: string | null;
	}>({
		isProcessing: false,
		progress: 0,
		outputUrl: null,
	});

	const [isDragging, setIsDragging] = useState(false);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const videoPreviewRef = useRef<HTMLVideoElement>(null);
	const outputVideoRef = useRef<HTMLVideoElement | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);

	const isVideoFile = (file: File): boolean => {
		return (
			file.type.startsWith("video/") ||
			SUPPORTED_VIDEO_FORMATS.some((format) =>
				file.name.toLowerCase().endsWith(`.${format}`),
			)
		);
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFile = e.target.files?.[0];
		if (selectedFile) {
			processFile(selectedFile);
		}
	};

	const cleanupResources = () => {
		if (fileState.videoSrc) {
			URL.revokeObjectURL(fileState.videoSrc);
		}

		setFileState((prev) => ({
			...prev,
			videoSrc: null,
			error: null,
		}));

		setVideoState((prev) => ({
			...prev,
			info: null,
			currentTime: 0,
		}));

		setTrimState({
			startTime: 0,
			endTime: 0,
		});
	};

	const processFile = (selectedFile: File) => {
		cleanupResources();

		setFileState((prev) => ({
			...prev,
			isLoading: true,
			error: null,
		}));

		if (!isVideoFile(selectedFile)) {
			setFileState((prev) => ({
				...prev,
				isLoading: false,
				error: "Please select a valid video file.",
			}));
			trackEvent("trimming_tool_invalid_file_type", {
				fileType: selectedFile.type,
			});
			return;
		}

		if (selectedFile.size > 500 * 1024 * 1024) {
			setFileState((prev) => ({
				...prev,
				isLoading: false,
				error: "File size exceeds 500MB limit.",
			}));
			trackEvent("trimming_tool_file_too_large", {
				fileSize: selectedFile.size,
			});
			return;
		}

		setFileState((prev) => ({
			...prev,
			file: selectedFile,
		}));

		try {
			const objectUrl = URL.createObjectURL(selectedFile);

			setTimeout(() => {
				setFileState((prev) => ({
					...prev,
					videoSrc: objectUrl,
				}));

				trackEvent("trimming_tool_file_selected", {
					fileSize: selectedFile.size,
					fileType: selectedFile.type,
				});
			}, 10);
		} catch (err) {
			console.error("Error creating object URL:", err);
			setFileState((prev) => ({
				...prev,
				isLoading: false,
				error: "Could not load video file. Please try a different file.",
			}));
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);

		if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
			const droppedFile = e.dataTransfer.files[0];
			if (droppedFile) {
				processFile(droppedFile);
			}
		} else {
			console.error("No file found in drop event");
			setFileState((prev) => ({
				...prev,
				error: "No file was received. Please try again.",
			}));
		}
	};

	const handleTimeUpdate = () => {
		if (videoPreviewRef.current) {
			setVideoState((prev) => ({
				...prev,
				currentTime: videoPreviewRef.current?.currentTime,
			}));
		}
	};

	const handleVideoLoaded = () => {
		if (videoPreviewRef.current) {
			const video = videoPreviewRef.current;

			if (
				Number.isNaN(video.duration) ||
				video.duration === Infinity ||
				video.duration === 0
			) {
				return;
			}

			const duration = video.duration;
			const dimensions = `${video.videoWidth}x${video.videoHeight}`;

			setVideoState((prev) => ({
				...prev,
				info: { duration, dimensions },
			}));

			setTrimState((prev) => ({
				...prev,
				endTime: duration,
			}));

			setFileState((prev) => ({
				...prev,
				isLoading: false,
			}));
		} else {
			console.error("Video reference is null in handleVideoLoaded");
		}
	};

	const handleVideoError = () => {
		const video = videoPreviewRef.current;
		console.error("Video error:", video?.error);

		let errorMsg =
			"Failed to load video. Please try a different file or format.";
		if (video?.error) {
			switch (video.error.code) {
				case MediaError.MEDIA_ERR_ABORTED:
					errorMsg = "Video loading aborted.";
					break;
				case MediaError.MEDIA_ERR_NETWORK:
					errorMsg = "Network error while loading video.";
					break;
				case MediaError.MEDIA_ERR_DECODE:
					errorMsg = "Video format not supported or corrupted.";
					break;
				case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
					errorMsg = "Video format not supported by your browser.";
					break;
			}
		}

		setFileState((prev) => ({
			...prev,
			error: errorMsg,
			isLoading: false,
		}));
	};

	const formatTime = (seconds: number) => {
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
	};

	const trimVideo = async () => {
		if (!fileState.file || !videoState.info) return;

		setProcessingState((prev) => ({
			...prev,
			isProcessing: true,
			progress: 0,
		}));

		setFileState((prev) => ({
			...prev,
			error: null,
		}));

		trackEvent("trimming_tool_trim_started", {
			fileSize: fileState.file.size,
			fileName: fileState.file.name,
			startTime: trimState.startTime,
			endTime: trimState.endTime,
			duration: trimState.endTime - trimState.startTime,
		});

		try {
			await processTrim();
		} catch (err: any) {
			console.error("Detailed processing error:", err);

			let errorMessage = "Trimming failed: ";
			if (err.message) {
				errorMessage += err.message;
			} else if (typeof err === "string") {
				errorMessage += err;
			} else {
				errorMessage += "Unknown error occurred during processing";
			}

			setFileState((prev) => ({
				...prev,
				error: errorMessage,
			}));

			trackEvent("trimming_tool_trim_failed", {
				fileSize: fileState.file.size,
				fileName: fileState.file.name,
				error: err.message || "Unknown error",
				startTime: trimState.startTime,
				endTime: trimState.endTime,
			});
		} finally {
			setProcessingState((prev) => ({
				...prev,
				isProcessing: false,
			}));
		}
	};

	const processTrim = async (): Promise<void> => {
		return new Promise((resolve, reject) => {
			if (!videoPreviewRef.current || !fileState.file) {
				reject(new Error("Video not loaded"));
				return;
			}

			try {
				const video = videoPreviewRef.current;
				const canvas = document.createElement("canvas");
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				const ctx = canvas.getContext("2d", { alpha: false });

				if (!ctx) {
					throw new Error("Failed to create canvas context");
				}

				let inputFormat = "video/webm";
				if (fileState.file.type) {
					inputFormat = fileState.file.type;
				} else if (fileState.file.name) {
					const extension = fileState.file.name.split(".").pop()?.toLowerCase();
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

				setVideoState((prev) => ({
					...prev,
					selectedMimeType,
				}));

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
						if (
							(video as any).mozHasAudio ||
							Boolean((video as any).webkitAudioDecodedByteCount) ||
							Boolean((video as any).audioTracks?.length)
						) {
							const audioContext = new (
								window.AudioContext || (window as any).webkitAudioContext
							)();
							const source = audioContext.createMediaElementSource(video);
							const destination = audioContext.createMediaStreamDestination();

							source.connect(destination);
							source.connect(audioContext.destination);

							const audioTracks = destination.stream.getAudioTracks();

							if (audioTracks.length > 0) {
								audioTracks.forEach((track) => {
									stream.addTrack(track);
								});
							} else {
								console.warn("No audio tracks found in destination stream");
							}
						} else {
							console.warn("Source video does not appear to have audio tracks");
						}
					} catch (audioErr) {
						console.error("Error setting up audio:", audioErr);
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
					try {
						const chunks = recordedChunksRef.current;
						const blob = new Blob(chunks, {
							type: selectedMimeType.split(";")[0],
						});
						const url = URL.createObjectURL(blob);

						setProcessingState((prev) => ({
							...prev,
							outputUrl: url,
						}));

						trackEvent("trimming_tool_trim_completed", {
							fileSize: fileState.file?.size,
							fileName: fileState.file?.name,
							outputSize: blob.size,
							startTime: trimState.startTime,
							endTime: trimState.endTime,
							duration: trimState.endTime - trimState.startTime,
						});

						resolve();
					} catch (error) {
						reject(error);
					}
				};

				recorder.start(100);

				video.currentTime = trimState.startTime;

				const duration = trimState.endTime - trimState.startTime;
				let recordingStartTime: number | null = null;

				const captureFrame = () => {
					if (video.currentTime >= trimState.endTime) {
						if (recorder.state === "recording") {
							recorder.stop();
							video.pause();
						}
						return;
					}

					ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

					if (recordingStartTime === null) {
						recordingStartTime = video.currentTime;
					}

					const elapsed = video.currentTime - trimState.startTime;
					const progress = Math.min((elapsed / duration) * 100, 99);

					setProcessingState((prev) => ({
						...prev,
						progress: Math.round(progress),
					}));

					requestAnimationFrame(captureFrame);
				};

				video
					.play()
					.then(() => {
						requestAnimationFrame(captureFrame);
					})
					.catch((err) => {
						console.error("Error playing video:", err);
						reject(err);
					});

				const safetyTimeout = setTimeout(
					() => {
						if (recorder.state === "recording") {
							recorder.stop();
						}
					},
					duration * 1000 + 10000,
				);

				video.onended = () => {
					clearTimeout(safetyTimeout);
					if (recorder.state === "recording") {
						recorder.stop();
					}
				};
			} catch (err) {
				reject(err);
			}
		});
	};

	const handleDownload = () => {
		if (!processingState.outputUrl || !fileState.file) return;

		const dotIndex = fileState.file.name.lastIndexOf(".");
		const baseName =
			dotIndex !== -1
				? fileState.file.name.substring(0, dotIndex)
				: fileState.file.name;

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
			if (videoState.selectedMimeType.includes("mp4")) {
				extension = "mp4";
			} else if (videoState.selectedMimeType.includes("webm")) {
				extension = "webm";
			} else if (
				videoState.selectedMimeType.includes("quicktime") ||
				videoState.selectedMimeType.includes("mov")
			) {
				extension = "mov";
			}
		}

		const downloadFileName = `${baseName}_trimmed.${extension}`;

		trackEvent("trimming_tool_download_clicked", {
			fileName: downloadFileName,
			startTime: trimState.startTime,
			endTime: trimState.endTime,
			duration: trimState.endTime - trimState.startTime,
		});

		const link = document.createElement("a");
		link.href = processingState.outputUrl;
		link.download = downloadFileName;
		link.click();
	};

	const resetTrimmer = () => {
		cleanupResources();

		if (processingState.outputUrl) {
			URL.revokeObjectURL(processingState.outputUrl);
		}

		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state !== "inactive"
		) {
			mediaRecorderRef.current.stop();
		}

		setProcessingState({
			isProcessing: false,
			progress: 0,
			outputUrl: null,
		});

		setFileState((prev) => ({
			...prev,
			error: null,
		}));

		recordedChunksRef.current = [];

		if (fileState.file) {
			const fileUrl = URL.createObjectURL(fileState.file);
			setFileState((prev) => ({
				...prev,
				videoSrc: fileUrl,
			}));
			if (videoPreviewRef.current) {
				videoPreviewRef.current.src = fileUrl;
			}
		}

		trackEvent("trimming_tool_reset");
	};

	const handleStartTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newStartTime = parseFloat(e.target.value);
		if (newStartTime < trimState.endTime) {
			setTrimState((prev) => ({
				...prev,
				startTime: newStartTime,
			}));
			if (videoPreviewRef.current) {
				videoPreviewRef.current.currentTime = newStartTime;
			}
		}
	};

	const handleEndTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newEndTime = parseFloat(e.target.value);
		if (newEndTime > trimState.startTime && videoState.info) {
			setTrimState((prev) => ({
				...prev,
				endTime: Math.min(newEndTime, videoState.info?.duration),
			}));
		}
	};

	const seekToStartTime = () => {
		if (videoPreviewRef.current) {
			videoPreviewRef.current.currentTime = trimState.startTime;
		}
	};

	const seekToEndTime = () => {
		if (videoPreviewRef.current) {
			videoPreviewRef.current.currentTime = trimState.endTime;
		}
	};

	const setCurrentPositionAsStart = () => {
		if (videoPreviewRef.current && videoState.currentTime < trimState.endTime) {
			setTrimState((prev) => ({
				...prev,
				startTime: videoPreviewRef.current?.currentTime,
			}));
		}
	};

	const setCurrentPositionAsEnd = () => {
		if (
			videoPreviewRef.current &&
			videoState.currentTime > trimState.startTime
		) {
			setTrimState((prev) => ({
				...prev,
				endTime: videoPreviewRef.current?.currentTime,
			}));
		}
	};

	useEffect(() => {
		const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(
			navigator.userAgent,
		);
		setVideoState((prev) => ({
			...prev,
			isSafari: isSafariBrowser,
		}));

		const preventDefaults = (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
		};

		window.addEventListener("dragover", preventDefaults);
		window.addEventListener("drop", preventDefaults);

		return () => {
			cleanupResources();
			if (processingState.outputUrl) {
				URL.revokeObjectURL(processingState.outputUrl);
			}
			window.removeEventListener("dragover", preventDefaults);
			window.removeEventListener("drop", preventDefaults);
		};
	}, [cleanupResources, processingState.outputUrl]);

	return (
		<div className="w-full">
			<h2 className="text-2xl font-semibold text-center mb-6">
				Trim Video Online
			</h2>

			<div
				className={
					!fileState.file || !fileState.videoSrc
						? "hidden"
						: "bg-black rounded-lg overflow-hidden mb-4"
				}
			>
				<video
					ref={videoPreviewRef}
					src={fileState.videoSrc || undefined}
					controls
					className="w-full max-h-[500px]"
					onTimeUpdate={handleTimeUpdate}
					onLoadedMetadata={handleVideoLoaded}
					onError={handleVideoError}
					playsInline
					preload="metadata"
				></video>
			</div>

			{!fileState.file && (
				<div
					className={`border-2 border-dashed rounded-lg p-8 mb-6 flex flex-col items-center justify-center cursor-pointer transition-colors ${
						isDragging
							? "border-blue-500 bg-blue-50"
							: "border-gray-300 hover:border-blue-400"
					}`}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
					onDragEnter={handleDragOver}
					onClick={() => fileInputRef.current?.click()}
					style={{ minHeight: "200px" }}
					role="button"
					tabIndex={0}
					aria-label="Drop video here or click to select"
				>
					<input
						type="file"
						accept="video/*"
						className="hidden"
						onChange={handleFileChange}
						ref={fileInputRef}
					/>

					<div className="text-center">
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
						<p className="text-xs text-blue-600 mt-2">
							Supported formats: {SUPPORTED_VIDEO_FORMATS.join(", ")}
						</p>
					</div>
				</div>
			)}

			{fileState.isLoading && (
				<div className="mb-6 text-center p-4">
					<div className="animate-spin inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full mb-2"></div>
					<p className="text-gray-600">Loading video...</p>
				</div>
			)}

			{fileState.error && (
				<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
					{fileState.error}
				</div>
			)}

			{fileState.file &&
				fileState.videoSrc &&
				!processingState.outputUrl &&
				!fileState.isLoading &&
				videoState.info && (
					<div className="mb-6">
						<div className="mb-4">
							<div className="flex items-center justify-between mb-2">
								<div className="text-sm font-medium text-gray-700">
									Current: {formatTime(videoState.currentTime)}
								</div>
								<div className="text-sm font-medium text-gray-700">
									Duration:{" "}
									{videoState.info
										? formatTime(videoState.info.duration)
										: "--:--"}
								</div>
							</div>

							<div className="flex items-center space-x-4 mb-4">
								<div className="flex-1">
									<label className="block text-sm font-medium text-gray-700 mb-1">
										Start Time: {formatTime(trimState.startTime)}
									</label>
									<div className="flex items-center space-x-2">
										<input
											type="range"
											min="0"
											max={videoState.info ? videoState.info.duration : 0}
											step="0.1"
											value={trimState.startTime}
											onChange={handleStartTimeChange}
											className="flex-1"
										/>
										<button
											onClick={seekToStartTime}
											className="p-1 bg-gray-200 rounded hover:bg-gray-300"
											title="Seek to start time"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												className="h-4 w-4"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M15 19l-7-7 7-7"
												/>
											</svg>
										</button>
										<button
											onClick={setCurrentPositionAsStart}
											className="p-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
											title="Set current position as start"
										>
											Set
										</button>
									</div>
								</div>

								<div className="flex-1">
									<label className="block text-sm font-medium text-gray-700 mb-1">
										End Time: {formatTime(trimState.endTime)}
									</label>
									<div className="flex items-center space-x-2">
										<input
											type="range"
											min={trimState.startTime}
											max={videoState.info ? videoState.info.duration : 0}
											step="0.1"
											value={trimState.endTime}
											onChange={handleEndTimeChange}
											className="flex-1"
										/>
										<button
											onClick={seekToEndTime}
											className="p-1 bg-gray-200 rounded hover:bg-gray-300"
											title="Seek to end time"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												className="h-4 w-4"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M9 5l7 7-7 7"
												/>
											</svg>
										</button>
										<button
											onClick={setCurrentPositionAsEnd}
											className="p-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
											title="Set current position as end"
										>
											Set
										</button>
									</div>
								</div>
							</div>

							<div className="text-sm text-gray-600">
								<span className="font-medium">Selected segment:</span>{" "}
								{formatTime(trimState.startTime)} to{" "}
								{formatTime(trimState.endTime)} (
								{formatTime(trimState.endTime - trimState.startTime)} duration)
							</div>
						</div>

						<div className="mt-6 flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
							<Button
								variant="primary"
								onClick={trimVideo}
								disabled={
									processingState.isProcessing ||
									trimState.startTime >= trimState.endTime
								}
								className="w-full"
							>
								{processingState.isProcessing
									? `Processing... ${processingState.progress}%`
									: "Trim Video"}
							</Button>
							<Button
								variant="white"
								onClick={() => {
									cleanupResources();
									setFileState((prev) => ({
										...prev,
										file: null,
									}));
								}}
								className="w-full"
							>
								Choose Different Video
							</Button>
						</div>
					</div>
				)}

			{processingState.isProcessing && (
				<div className="mb-6">
					<p className="text-center text-gray-700 mb-2">
						Trimming video... {processingState.progress}%
					</p>
					<div className="w-full bg-gray-200 rounded-full h-2">
						<div
							className="bg-blue-600 h-2 rounded-full transition-all"
							style={{ width: `${processingState.progress}%` }}
						></div>
					</div>
				</div>
			)}

			{processingState.outputUrl && (
				<div className="mb-6 p-5 bg-green-50 border border-green-200 rounded-lg">
					<p className="text-green-700 font-medium mb-3">
						Video trimmed successfully!
					</p>
					<video
						ref={outputVideoRef}
						src={processingState.outputUrl}
						controls
						className="w-full rounded-lg mb-4 bg-black"
						style={{ maxHeight: "400px" }}
						playsInline
					></video>
					<div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
						<Button
							variant="primary"
							onClick={handleDownload}
							className="w-full"
						>
							Download Trimmed Video
						</Button>
						<Button variant="white" onClick={resetTrimmer} className="w-full">
							Trim Again
						</Button>
					</div>
				</div>
			)}

			<div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
				<p>
					This tool works entirely in your browser. Your videos are never
					uploaded to any server.
				</p>
				{videoState.isSafari && (
					<div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
						<p>
							<strong>Safari Compatibility Notice:</strong> Safari has limited
							support for some video processing features. For best results,
							consider using Chrome or Firefox. Audio capture in particular may
							not work correctly in Safari.
						</p>
					</div>
				)}
			</div>
		</div>
	);
};
