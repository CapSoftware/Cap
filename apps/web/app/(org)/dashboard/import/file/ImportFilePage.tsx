"use client";

import { Button } from "@cap/ui";
import type { Folder, Organisation } from "@cap/web-domain";
import { faArrowLeft, faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useStore } from "@tanstack/react-store";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { triggerVideoProcessing } from "@/actions/video/trigger-processing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { sendProgressUpdate } from "@/app/(org)/dashboard/caps/components/sendProgressUpdate";
import {
	type UploadStatus,
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";
import { UpgradeModal } from "@/components/UpgradeModal";

export const ImportFilePage = () => {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const { uploadingStore, setUploadStatus } = useUploadingContext();
	const isUploading = useStore(uploadingStore, (s) => !!s.uploadStatus);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(!user?.isPro);
	const [isDragOver, setIsDragOver] = useState(false);

	const processFile = useCallback(
		async (file: File) => {
			if (!user || !activeOrganization) return;

			if (!user.isPro) {
				setUpgradeModalOpen(true);
				return;
			}

			const ok = await uploadVideoForServerProcessing(
				file,
				undefined,
				activeOrganization.organization.id,
				setUploadStatus,
			);
			if (ok) router.push("/dashboard/caps");
		},
		[user, activeOrganization, setUploadStatus, router],
	);

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		await processFile(file);
		if (inputRef.current) inputRef.current.value = "";
	};

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			const file = e.dataTransfer.files[0];
			if (!file) return;

			const isVideo =
				file.type.startsWith("video/") ||
				/\.(mov|mp4|avi|mkv|webm|m4v)$/i.test(file.name);
			if (!isVideo) {
				toast.error("Please drop a video file.");
				return;
			}
			await processFile(file);
		},
		[processFile],
	);

	const handleBrowseClick = () => {
		if (!user) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		inputRef.current?.click();
	};

	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);
	const progressPercent =
		uploadStatus && "progress" in uploadStatus
			? Math.round(uploadStatus.progress)
			: null;
	const statusLabel = uploadStatus
		? uploadStatus.status === "parsing"
			? "Analyzing video..."
			: uploadStatus.status === "creating"
				? "Preparing upload..."
				: uploadStatus.status === "uploadingVideo"
					? `Uploading... ${progressPercent ?? 0}%`
					: uploadStatus.status === "serverProcessing"
						? "Processing on server..."
						: "Working..."
		: null;

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href="/dashboard/import"
					className="inline-flex gap-2 items-center text-sm text-gray-10 hover:text-gray-12 transition-colors mb-4"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<h1 className="text-2xl font-medium text-gray-12">Upload File</h1>
				<p className="mt-1 text-sm text-gray-10">
					Upload a video file from your device.
				</p>
			</div>

			<div
				onDragOver={(e) => {
					e.preventDefault();
					if (!isUploading) setIsDragOver(true);
				}}
				onDragLeave={() => setIsDragOver(false)}
				onDrop={handleDrop}
				className={`relative flex flex-col items-center justify-center w-full max-w-2xl rounded-xl border-2 border-dashed transition-all duration-200 py-16 px-8 ${
					isUploading
						? "border-gray-4 bg-gray-2 cursor-not-allowed"
						: isDragOver
							? "border-blue-10 bg-blue-3"
							: "border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
				}`}
			>
				{isUploading ? (
					<div className="flex flex-col items-center gap-4">
						<div className="flex items-center justify-center size-16 rounded-full bg-gray-3">
							<div className="size-6 border-2 border-gray-8 border-t-blue-10 rounded-full animate-spin" />
						</div>
						<div className="flex flex-col items-center gap-1">
							<p className="text-sm font-medium text-gray-12">{statusLabel}</p>
							{progressPercent !== null && (
								<div className="w-48 h-1.5 rounded-full bg-gray-4 mt-2 overflow-hidden">
									<div
										className="h-full rounded-full bg-blue-10 transition-all duration-300"
										style={{ width: `${progressPercent}%` }}
									/>
								</div>
							)}
						</div>
					</div>
				) : (
					<div className="flex flex-col items-center gap-4">
						<div className="flex items-center justify-center size-16 rounded-full bg-gray-3 text-gray-10">
							<FontAwesomeIcon className="size-6" icon={faUpload} />
						</div>
						<div className="flex flex-col items-center gap-1">
							<p className="text-sm font-medium text-gray-12">
								Drag and drop your video here
							</p>
							<p className="text-xs text-gray-10">
								MP4, MOV, AVI, MKV, WebM up to any size
							</p>
						</div>
						<Button
							onClick={handleBrowseClick}
							variant="dark"
							size="sm"
							className="mt-2"
						>
							Browse Files
						</Button>
					</div>
				)}
			</div>

			<input
				ref={inputRef}
				type="file"
				accept="video/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V"
				onChange={handleFileChange}
				className="hidden"
			/>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</div>
	);
};

async function uploadVideoForServerProcessing(
	file: File,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
) {
	try {
		setUploadStatus({ status: "parsing" });

		let duration: number | undefined;
		let resolution: string | undefined;

		try {
			const parser = await import("@remotion/media-parser");
			const metadata = await parser.parseMedia({
				src: file,
				fields: {
					durationInSeconds: true,
					dimensions: true,
				},
			});

			duration = metadata.durationInSeconds
				? Math.round(metadata.durationInSeconds)
				: undefined;
			resolution = metadata.dimensions
				? `${metadata.dimensions.width}x${metadata.dimensions.height}`
				: undefined;
		} catch (parseError) {
			console.warn(
				"Failed to parse video metadata, continuing without it:",
				parseError,
			);
		}

		setUploadStatus({ status: "creating" });
		const videoData = await createVideoForServerProcessing({
			duration,
			resolution,
			folderId,
			orgId,
		});

		const uploadId = videoData.id;

		setUploadStatus({
			status: "uploadingVideo",
			capId: uploadId,
			progress: 0,
			thumbnailUrl: undefined,
		});

		const formData = new FormData();
		Object.entries(videoData.presignedPostData.fields).forEach(
			([key, value]) => {
				formData.append(key, value as string);
			},
		);
		formData.append("file", file);

		const createProgressTracker = () => {
			const uploadState = {
				videoId: uploadId,
				uploaded: 0,
				total: 0,
				pendingTask: undefined as ReturnType<typeof setTimeout> | undefined,
				lastUpdateTime: Date.now(),
			};

			const scheduleProgressUpdate = (uploaded: number, total: number) => {
				uploadState.uploaded = uploaded;
				uploadState.total = total;
				uploadState.lastUpdateTime = Date.now();

				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}

				const shouldSendImmediately = uploaded >= total;

				if (!shouldSendImmediately) {
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

		const progressTracker = createProgressTracker();

		try {
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
							thumbnailUrl: undefined,
						});

						progressTracker.scheduleProgressUpdate(event.loaded, event.total);
					}
				};

				xhr.onload = () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						progressTracker.cleanup();
						const total = progressTracker.getTotal() || 1;
						sendProgressUpdate(uploadId, total, total);
						resolve();
					} else {
						progressTracker.cleanup();
						reject(new Error(`Upload failed with status ${xhr.status}`));
					}
				};
				xhr.onerror = () => {
					progressTracker.cleanup();
					reject(new Error("Upload failed"));
				};

				xhr.send(formData);
			});
		} catch (uploadError) {
			progressTracker.cleanup();
			throw uploadError;
		}

		setUploadStatus({
			status: "serverProcessing",
			capId: uploadId,
		});

		try {
			await triggerVideoProcessing({
				videoId: uploadId,
				rawFileKey: videoData.rawFileKey,
				bucketId: videoData.bucketId,
			});
		} catch (triggerError) {
			console.error("Failed to trigger processing:", triggerError);
			toast.error("Failed to start video processing. Please try again.");
			setUploadStatus(undefined);
			return false;
		}

		setUploadStatus(undefined);
		toast.success(
			"Video uploaded! Processing will continue in the background.",
		);
		return true;
	} catch (err) {
		console.error("Video upload failed", err);

		if (err instanceof Error && err.message === "upgrade_required") {
			toast.error(
				"Video duration exceeds the limit for free accounts. Please upgrade to Pro.",
			);
		} else {
			toast.error("Failed to upload video. Please try again.");
		}
	}

	setUploadStatus(undefined);
	return false;
}
