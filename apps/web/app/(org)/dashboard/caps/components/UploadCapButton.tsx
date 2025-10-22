"use client";

import { Button } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import type { Folder, Organisation, Video } from "@cap/web-domain";
import { faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import {
	type UploadStatus,
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { Effect, Queue, Stream } from "effect";
import { useFeatureFlag } from "@/app/Layout/features";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";

export const UploadCapButton = ({
	size = "md",
	folderId,
}: {
	size?: "sm" | "lg" | "md";
	grey?: boolean;
	folderId?: Folder.FolderId;
}) => {
	const { user, activeOrganization } = useDashboardContext();
	const inputRef = useRef<HTMLInputElement>(null);
	const { uploadingStore, setUploadStatus } = useUploadingContext();
	const isUploading = useStore(uploadingStore, (s) => !!s.uploadStatus);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const router = useRouter();
	const queryClient = useQueryClient();

	const handleClick = () => {
		if (!user) return;

		const isCapPro = userIsPro(user);

		if (!isCapPro) {
			setUpgradeModalOpen(true);
			return;
		}

		inputRef.current?.click();
	};

	const uploadCapMutation = useEffectMutation({
		mutationFn: (file: File) =>
			uploadCap(file, folderId, setUploadStatus, queryClient),
		onSuccess: () => {
			router.refresh();
			if (inputRef.current) inputRef.current.value = "";
		},
		onError: (error) => {
			console.error("Upload failed:", error);
			toast.error(
				"Failed to process video file. This format may not be supported for upload.",
			);
			if (inputRef.current) inputRef.current.value = "";
		},
	});

	const useEffectForUploadButton = useFeatureFlag("enableEffectOnUploadButton");
	const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file || !user) return;

		// This should be unreachable.
		if (activeOrganization === null) {
			alert("No organization active!");
			return;
		}

		if (useEffectForUploadButton) uploadCapMutation.mutate(file);
		else {
			const ok = await legacyUploadCap(
				file,
				folderId,
				activeOrganization.organization.id,
				setUploadStatus,
				queryClient,
			);
			if (ok) router.refresh();
			if (inputRef.current) inputRef.current.value = "";
		}
	};

	return (
		<>
			<Button
				onClick={handleClick}
				disabled={isUploading}
				variant="dark"
				className="flex gap-2 items-center"
				size={size}
				spinner={isUploading}
			>
				<FontAwesomeIcon className="size-3.5" icon={faUpload} />
				{isUploading ? "Uploading..." : "Upload Video"}
			</Button>
			<input
				ref={inputRef}
				type="file"
				accept="video/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V"
				onChange={handleChange}
				className="hidden"
			/>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};

const uploadCap = (
	file: File,
	folderId: Folder.FolderId | undefined,
	setUploadStatus: (state: UploadStatus | undefined) => void,
	queryClient: QueryClient,
) =>
	Effect.gen(function* () {
		const parser = yield* Effect.promise(
			() => import("@remotion/media-parser"),
		);
		const webcodecs = yield* Effect.promise(
			() => import("@remotion/webcodecs"),
		);

		setUploadStatus({ status: "parsing" });

		const metadata = yield* Effect.promise(() =>
			parser.parseMedia({
				src: file,
				fields: {
					durationInSeconds: true,
					dimensions: true,
					fps: true,
					numberOfAudioChannels: true,
					sampleRate: true,
				},
			}),
		);

		const duration = metadata.durationInSeconds
			? Math.round(metadata.durationInSeconds)
			: undefined;

		setUploadStatus({ status: "creating" });

		const videoData = yield* Effect.promise(() =>
			createVideoAndGetUploadUrl({
				duration,
				resolution: metadata.dimensions
					? `${metadata.dimensions.width}x${metadata.dimensions.height}`
					: undefined,
				videoCodec: "h264",
				audioCodec: "aac",
				isScreenshot: false,
				isUpload: true,
				folderId,
			}),
		);

		const uploadId = videoData.id;
		setUploadStatus({ status: "converting", capId: uploadId, progress: 0 });

		const calculateResizeOptions = () => {
			if (!metadata.dimensions) return undefined;

			const { width, height } = metadata.dimensions;
			const maxWidth = 1920;
			const maxHeight = 1080;

			if (width <= maxWidth && height <= maxHeight) {
				return undefined;
			}

			const widthScale = maxWidth / width;
			const heightScale = maxHeight / height;
			const scale = Math.min(widthScale, heightScale);

			return { mode: "scale" as const, scale };
		};

		const resizeOptions = calculateResizeOptions();

		const optimizedBlob = yield* Effect.promise(() => {
			return webcodecs
				.convertMedia({
					src: file,
					container: "mp4",
					videoCodec: "h264",
					audioCodec: "aac",
					...(resizeOptions && { resize: resizeOptions }),
					onProgress: ({ overallProgress }) => {
						if (overallProgress !== null) {
							const progressValue = overallProgress * 100;
							setUploadStatus({
								status: "converting",
								capId: uploadId,
								progress: progressValue,
							});
						}
					},
				})
				.then((result) => result.save());
		}).pipe(
			Effect.filterOrFail(
				(blob) => blob.size > 0,
				() => new Error("Conversion produced empty file"),
			),
			Effect.catchAll((error) => {
				console.error("Video conversion failed:", error);
				toast.error(
					"Failed to process video file. This format may not be supported for upload.",
				);
				setUploadStatus(undefined);
				return Effect.fail(error);
			}),
		);

		const isValidVideo = yield* Effect.promise(
			() =>
				new Promise<boolean>((resolve) => {
					const testVideo = document.createElement("video");
					testVideo.muted = true;
					testVideo.playsInline = true;
					testVideo.preload = "metadata";

					const timeout = setTimeout(() => {
						console.warn("Video validation timed out");
						URL.revokeObjectURL(testVideo.src);
						resolve(false);
					}, 15000);

					let metadataLoaded = false;

					const validateVideo = () => {
						if (metadataLoaded) return;
						metadataLoaded = true;

						const hasValidDuration =
							testVideo.duration > 0 &&
							!isNaN(testVideo.duration) &&
							isFinite(testVideo.duration);

						const hasValidDimensions =
							(testVideo.videoWidth > 0 && testVideo.videoHeight > 0) ||
							(metadata.dimensions &&
								metadata.dimensions.width > 0 &&
								metadata.dimensions.height > 0);

						if (hasValidDuration && hasValidDimensions) {
							clearTimeout(timeout);
							URL.revokeObjectURL(testVideo.src);
							resolve(true);
						} else {
							console.warn(
								`Invalid video properties - Duration: ${testVideo.duration}, Dimensions: ${testVideo.videoWidth}x${testVideo.videoHeight}, Original dimensions: ${metadata.dimensions?.width}x${metadata.dimensions?.height}`,
							);
							clearTimeout(timeout);
							URL.revokeObjectURL(testVideo.src);
							resolve(false);
						}
					};

					testVideo.addEventListener("loadedmetadata", validateVideo);
					testVideo.addEventListener("loadeddata", validateVideo);
					testVideo.addEventListener("canplay", validateVideo);

					testVideo.addEventListener("error", (e) => {
						console.error("Video validation error:", e);
						clearTimeout(timeout);
						URL.revokeObjectURL(testVideo.src);
						resolve(false);
					});

					testVideo.addEventListener("loadstart", () => {});
					testVideo.src = URL.createObjectURL(optimizedBlob);
				}),
		).pipe(
			Effect.filterOrFail(
				(valid) => valid,
				() => new Error("Converted video is not playable"),
			),
		);

		const thumbnailBlob = yield* Effect.promise(
			() =>
				new Promise<Blob | null>((resolve) => {
					const video = document.createElement("video");
					video.src = URL.createObjectURL(optimizedBlob);
					video.muted = true;
					video.playsInline = true;
					video.crossOrigin = "anonymous";

					const cleanup = () => {
						URL.revokeObjectURL(video.src);
					};

					const timeout = setTimeout(() => {
						cleanup();
						console.warn(
							"Thumbnail generation timed out, proceeding without thumbnail",
						);
						resolve(null);
					}, 10000);

					video.addEventListener("loadedmetadata", () => {
						try {
							const seekTime = Math.min(1, video.duration / 4);
							video.currentTime = seekTime;
						} catch (err) {
							console.warn("Failed to seek video for thumbnail:", err);
							clearTimeout(timeout);
							cleanup();
							resolve(null);
						}
					});

					video.addEventListener("seeked", () => {
						try {
							const canvas = document.createElement("canvas");
							canvas.width = video.videoWidth || 640;
							canvas.height = video.videoHeight || 480;
							const ctx = canvas.getContext("2d");
							if (!ctx) {
								console.warn("Failed to get canvas context");
								clearTimeout(timeout);
								cleanup();
								resolve(null);
								return;
							}
							ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
							canvas.toBlob(
								(blob) => {
									clearTimeout(timeout);
									cleanup();
									if (blob) {
										resolve(blob);
									} else {
										console.warn("Failed to create thumbnail blob");
										resolve(null);
									}
								},
								"image/jpeg",
								0.8,
							);
						} catch (err) {
							console.warn("Error during thumbnail capture:", err);
							clearTimeout(timeout);
							cleanup();
							resolve(null);
						}
					});

					video.addEventListener("error", (err) => {
						console.warn("Video loading error for thumbnail:", err);
						clearTimeout(timeout);
						cleanup();
						resolve(null);
					});

					video.addEventListener("loadstart", () => {});
				}),
		);

		const thumbnailUrl = thumbnailBlob
			? URL.createObjectURL(thumbnailBlob)
			: undefined;

		yield* Effect.gen(function* () {
			const videoUpload = createUploadEffect(
				optimizedBlob,
				videoData,
				uploadId,
				thumbnailUrl,
				setUploadStatus,
				"video",
			);

			if (thumbnailBlob) {
				const screenshotData = yield* Effect.promise(() =>
					createVideoAndGetUploadUrl({
						videoId: uploadId,
						isScreenshot: true,
						isUpload: true,
					}),
				);

				const thumbnailUpload = createUploadEffect(
					thumbnailBlob,
					screenshotData,
					uploadId,
					undefined,
					setUploadStatus,
					"thumbnail",
				).pipe(
					Effect.tap(() => queryClient.refetchQueries(imageUrlQuery(uploadId))),
				);

				yield* Effect.all([videoUpload, thumbnailUpload], { concurrency: 2 });
			} else {
				yield* videoUpload;
			}
		});

		setUploadStatus(undefined);
		return true;
	}).pipe(
		Effect.catchAll((error) => {
			console.error("Video upload failed", error);
			setUploadStatus(undefined);
			return Effect.succeed(false);
		}),
	);

const createUploadEffect = (
	blob: Blob,
	uploadData: any,
	uploadId: string,
	thumbnailUrl: string | undefined,
	setUploadStatus: (state: UploadStatus | undefined) => void,
	uploadType: "video" | "thumbnail",
) =>
	Effect.gen(function* () {
		const formData = new FormData();
		Object.entries(uploadData.presignedPostData.fields).forEach(
			([key, value]) => {
				formData.append(key, value as string);
			},
		);
		formData.append("file", blob);

		const progressQueue = yield* Queue.unbounded<{
			loaded: number;
			total: number;
		}>();

		if (uploadType === "video") {
			setUploadStatus({
				status: "uploadingVideo",
				capId: uploadId,
				progress: 0,
				thumbnailUrl,
			});
		} else {
			setUploadStatus({
				status: "uploadingThumbnail",
				capId: uploadId,
				progress: 0,
			});
		}

		const progressTracker = createProgressTracker();

		const progressStream = Stream.fromQueue(progressQueue).pipe(
			Stream.tap(({ loaded, total }) =>
				Effect.sync(() => {
					const percent = (loaded / total) * 100;
					if (uploadType === "video") {
						setUploadStatus({
							status: "uploadingVideo",
							capId: uploadId,
							progress: percent,
							thumbnailUrl,
						});
						progressTracker.scheduleProgressUpdate(uploadId, loaded, total);
					} else {
						const thumbnailProgress = 90 + percent * 0.1;
						setUploadStatus({
							status: "uploadingThumbnail",
							capId: uploadId,
							progress: thumbnailProgress,
						});
					}
				}),
			),
			Stream.runDrain,
		);

		const uploadEffect = Effect.promise(
			() =>
				new Promise<void>((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					xhr.open("POST", uploadData.presignedPostData.url);

					xhr.upload.onprogress = (event) => {
						if (event.lengthComputable) {
							Effect.runSync(
								Queue.offer(progressQueue, {
									loaded: event.loaded,
									total: event.total,
								}),
							);
						}
					};

					xhr.onload = () => {
						if (xhr.status >= 200 && xhr.status < 300) {
							progressTracker.cleanup();
							if (uploadType === "video") {
								const total = progressTracker.getTotal() || 1;
								sendProgressUpdate(uploadId, total, total);
							}
							Effect.runSync(Queue.shutdown(progressQueue));
							resolve();
						} else {
							progressTracker.cleanup();
							Effect.runSync(Queue.shutdown(progressQueue));
							reject(new Error(`Upload failed with status ${xhr.status}`));
						}
					};
					xhr.onerror = () => {
						progressTracker.cleanup();
						Effect.runSync(Queue.shutdown(progressQueue));
						reject(new Error("Upload failed"));
					};

					xhr.send(formData);
				}),
		);

		yield* Effect.race(progressStream, uploadEffect);
	});

const createProgressTracker = () => {
	const uploadState = {
		videoId: "",
		uploaded: 0,
		total: 0,
		pendingTask: undefined as ReturnType<typeof setTimeout> | undefined,
		lastUpdateTime: Date.now(),
	};

	const scheduleProgressUpdate = (
		videoId: string,
		uploaded: number,
		total: number,
	) => {
		uploadState.videoId = videoId;
		uploadState.uploaded = uploaded;
		uploadState.total = total;
		uploadState.lastUpdateTime = Date.now();

		if (uploadState.pendingTask) {
			clearTimeout(uploadState.pendingTask);
			uploadState.pendingTask = undefined;
		}

		const shouldSendImmediately = uploaded >= total;

		if (shouldSendImmediately) {
			return;
		} else {
			uploadState.pendingTask = setTimeout(() => {
				if (uploadState.videoId) {
					sendProgressUpdate(
						uploadState.videoId,
						uploadState.uploaded,
						uploadState.total,
					);
				}
				uploadState.pendingTask = undefined;
			}, 2000);
		}
	};

	const cleanup = () => {
		if (uploadState.pendingTask) {
			clearTimeout(uploadState.pendingTask);
			uploadState.pendingTask = undefined;
		}
	};

	const getTotal = () => uploadState.total;

	return { scheduleProgressUpdate, cleanup, getTotal };
};

async function legacyUploadCap(
	file: File,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
	queryClient: QueryClient,
) {
	const parser = await import("@remotion/media-parser");
	const webcodecs = await import("@remotion/webcodecs");

	try {
		setUploadStatus({ status: "parsing" });
		const metadata = await parser.parseMedia({
			src: file,
			fields: {
				durationInSeconds: true,
				dimensions: true,
				fps: true,
				numberOfAudioChannels: true,
				sampleRate: true,
			},
		});

		const duration = metadata.durationInSeconds
			? Math.round(metadata.durationInSeconds)
			: undefined;

		setUploadStatus({ status: "creating" });
		const videoData = await createVideoAndGetUploadUrl({
			duration,
			resolution: metadata.dimensions
				? `${metadata.dimensions.width}x${metadata.dimensions.height}`
				: undefined,
			videoCodec: "h264",
			audioCodec: "aac",
			isScreenshot: false,
			isUpload: true,
			folderId,
			orgId,
			supportsUploadProgress: false,
		});

		const uploadId = videoData.id;

		setUploadStatus({ status: "converting", capId: uploadId, progress: 0 });

		let optimizedBlob: Blob;

		try {
			const calculateResizeOptions = () => {
				if (!metadata.dimensions) return undefined;

				const { width, height } = metadata.dimensions;
				const maxWidth = 1920;
				const maxHeight = 1080;

				if (width <= maxWidth && height <= maxHeight) {
					return undefined;
				}

				const widthScale = maxWidth / width;
				const heightScale = maxHeight / height;
				const scale = Math.min(widthScale, heightScale);

				return { mode: "scale" as const, scale };
			};

			const resizeOptions = calculateResizeOptions();

			const convertResult = await webcodecs.convertMedia({
				src: file,
				container: "mp4",
				videoCodec: "h264",
				audioCodec: "aac",
				...(resizeOptions && { resize: resizeOptions }),
				onProgress: ({ overallProgress }) => {
					if (overallProgress !== null) {
						const progressValue = overallProgress * 100;
						setUploadStatus({
							status: "converting",
							capId: uploadId,
							progress: progressValue,
						});
					}
				},
			});
			optimizedBlob = await convertResult.save();

			if (optimizedBlob.size === 0)
				throw new Error("Conversion produced empty file");
			const isValidVideo = await new Promise<boolean>((resolve) => {
				const testVideo = document.createElement("video");
				testVideo.muted = true;
				testVideo.playsInline = true;
				testVideo.preload = "metadata";

				const timeout = setTimeout(() => {
					console.warn("Video validation timed out");
					URL.revokeObjectURL(testVideo.src);
					resolve(false);
				}, 15000);

				let metadataLoaded = false;

				const validateVideo = () => {
					if (metadataLoaded) return;
					metadataLoaded = true;

					const hasValidDuration =
						testVideo.duration > 0 &&
						!isNaN(testVideo.duration) &&
						isFinite(testVideo.duration);

					const hasValidDimensions =
						(testVideo.videoWidth > 0 && testVideo.videoHeight > 0) ||
						(metadata.dimensions &&
							metadata.dimensions.width > 0 &&
							metadata.dimensions.height > 0);

					if (hasValidDuration && hasValidDimensions) {
						clearTimeout(timeout);
						URL.revokeObjectURL(testVideo.src);
						resolve(true);
					} else {
						console.warn(
							`Invalid video properties - Duration: ${testVideo.duration}, Dimensions: ${testVideo.videoWidth}x${testVideo.videoHeight}, Original dimensions: ${metadata.dimensions?.width}x${metadata.dimensions?.height}`,
						);
						clearTimeout(timeout);
						URL.revokeObjectURL(testVideo.src);
						resolve(false);
					}
				};

				testVideo.addEventListener("loadedmetadata", validateVideo);
				testVideo.addEventListener("loadeddata", validateVideo);
				testVideo.addEventListener("canplay", validateVideo);

				testVideo.addEventListener("error", (e) => {
					console.error("Video validation error:", e);
					clearTimeout(timeout);
					URL.revokeObjectURL(testVideo.src);
					resolve(false);
				});

				testVideo.addEventListener("loadstart", () => {});

				testVideo.src = URL.createObjectURL(optimizedBlob);
			});

			if (!isValidVideo) {
				throw new Error("Converted video is not playable");
			}
		} catch (conversionError) {
			console.error("Video conversion failed:", conversionError);
			toast.error(
				"Failed to process video file. This format may not be supported for upload.",
			);
			setUploadStatus(undefined);
			return false;
		}

		const captureThumbnail = (): Promise<Blob | null> => {
			return new Promise((resolve) => {
				const video = document.createElement("video");
				video.src = URL.createObjectURL(optimizedBlob);
				video.muted = true;
				video.playsInline = true;
				video.crossOrigin = "anonymous";

				const cleanup = () => {
					URL.revokeObjectURL(video.src);
				};

				const timeout = setTimeout(() => {
					cleanup();
					console.warn(
						"Thumbnail generation timed out, proceeding without thumbnail",
					);
					resolve(null);
				}, 10000);

				video.addEventListener("loadedmetadata", () => {
					try {
						const seekTime = Math.min(1, video.duration / 4);
						video.currentTime = seekTime;
					} catch (err) {
						console.warn("Failed to seek video for thumbnail:", err);
						clearTimeout(timeout);
						cleanup();
						resolve(null);
					}
				});

				video.addEventListener("seeked", () => {
					try {
						const canvas = document.createElement("canvas");
						canvas.width = video.videoWidth || 640;
						canvas.height = video.videoHeight || 480;
						const ctx = canvas.getContext("2d");
						if (!ctx) {
							console.warn("Failed to get canvas context");
							clearTimeout(timeout);
							cleanup();
							resolve(null);
							return;
						}
						ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
						canvas.toBlob(
							(blob) => {
								clearTimeout(timeout);
								cleanup();
								if (blob) {
									resolve(blob);
								} else {
									console.warn("Failed to create thumbnail blob");
									resolve(null);
								}
							},
							"image/jpeg",
							0.8,
						);
					} catch (err) {
						console.warn("Error during thumbnail capture:", err);
						clearTimeout(timeout);
						cleanup();
						resolve(null);
					}
				});

				video.addEventListener("error", (err) => {
					console.warn("Video loading error for thumbnail:", err);
					clearTimeout(timeout);
					cleanup();
					resolve(null);
				});

				video.addEventListener("loadstart", () => {});
			});
		};

		const thumbnailBlob = await captureThumbnail();
		const thumbnailUrl = thumbnailBlob
			? URL.createObjectURL(thumbnailBlob)
			: undefined;

		const formData = new FormData();
		Object.entries(videoData.presignedPostData.fields).forEach(
			([key, value]) => {
				formData.append(key, value as string);
			},
		);
		formData.append("file", optimizedBlob);

		setUploadStatus({
			status: "uploadingVideo",
			capId: uploadId,
			progress: 0,
			thumbnailUrl,
		});

		await new Promise<void>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", videoData.presignedPostData.url);

			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) {
					const percent = (event.loaded / event.total) * 100;
					setUploadStatus({
						status: "uploadingVideo",
						capId: uploadId,
						progress: percent,
						thumbnailUrl,
					});
				}
			};

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new Error(`Upload failed with status ${xhr.status}`));
				}
			};
			xhr.onerror = () => {
				reject(new Error("Upload failed"));
			};

			xhr.send(formData);
		});

		if (thumbnailBlob) {
			const screenshotData = await createVideoAndGetUploadUrl({
				videoId: uploadId,
				isScreenshot: true,
				isUpload: true,
				orgId,
			});

			const screenshotFormData = new FormData();
			Object.entries(screenshotData.presignedPostData.fields).forEach(
				([key, value]) => {
					screenshotFormData.append(key, value as string);
				},
			);
			screenshotFormData.append("file", thumbnailBlob);

			setUploadStatus({
				status: "uploadingThumbnail",
				capId: uploadId,
				progress: 0,
			});
			await new Promise<void>((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open("POST", screenshotData.presignedPostData.url);

				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						const percent = (event.loaded / event.total) * 100;
						const thumbnailProgress = 90 + percent * 0.1;
						setUploadStatus({
							status: "uploadingThumbnail",
							capId: uploadId,
							progress: thumbnailProgress,
						});
					}
				};

				xhr.onload = () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						resolve();
						queryClient.refetchQueries({
							queryKey: ThumbnailRequest.queryKey(uploadId),
						});
					} else {
						reject(
							new Error(`Screenshot upload failed with status ${xhr.status}`),
						);
					}
				};
				xhr.onerror = () => reject(new Error("Screenshot upload failed"));

				xhr.send(screenshotFormData);
			});
		}

		setUploadStatus(undefined);
		return true;
	} catch (err) {
		console.error("Video upload failed", err);
	}

	setUploadStatus(undefined);
	return false;
}

const sendProgressUpdate = async (
	videoId: string,
	uploaded: number,
	total: number,
) => {
	try {
		const response = await fetch("/api/desktop/video/progress", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				videoId,
				uploaded,
				total,
				updatedAt: new Date().toISOString(),
			}),
		});

		if (!response.ok)
			console.error("Failed to send progress update:", response.status);
	} catch (err) {
		console.error("Error sending progress update:", err);
	}
};
