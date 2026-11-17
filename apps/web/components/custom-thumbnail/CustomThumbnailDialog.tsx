"use client";

import { Dialog, DialogContent, DialogTitle } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ImageIcon, LoaderCircle, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
	type DragEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	resetCustomThumbnail,
	setCustomThumbnailFromFrame,
	uploadCustomThumbnail,
} from "@/actions/videos/custom-thumbnail";
import {
	CUSTOM_THUMBNAIL_ACCEPT,
	CUSTOM_THUMBNAIL_MAX_BYTES,
	fitThumbnailSize,
	validateThumbnailSourceFile,
} from "@/lib/custom-thumbnail";
import { formatClockWithHundredths } from "@/lib/player-time";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";

type Mode = "frame" | "upload";
type Pending = "save" | "reset" | null;
type PreparedImage = { blob: Blob; previewUrl: string };

const JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58];

async function prepareThumbnailImage(file: File): Promise<PreparedImage> {
	const bitmap = await createImageBitmap(file);
	try {
		const size = fitThumbnailSize(bitmap.width, bitmap.height);
		if (!size) throw new Error("empty");
		const canvas = document.createElement("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no canvas");
		context.fillStyle = "#000";
		context.fillRect(0, 0, size.width, size.height);
		context.drawImage(bitmap, 0, 0, size.width, size.height);
		for (const quality of JPEG_QUALITIES) {
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/jpeg", quality),
			);
			if (blob && blob.size <= CUSTOM_THUMBNAIL_MAX_BYTES) {
				return { blob, previewUrl: URL.createObjectURL(blob) };
			}
		}
		throw new Error("too large");
	} finally {
		bitmap.close();
	}
}

export function CustomThumbnailDialog({
	open,
	onOpenChange,
	videoId,
	hasCustomThumbnail,
	canPickFrame,
	initialFrameTime,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	videoId: Video.VideoId;
	hasCustomThumbnail: boolean;
	canPickFrame: boolean;
	initialFrameTime?: number | null;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const ids = { file: useId(), scrubber: useId() };
	const [mode, setMode] = useState<Mode>(canPickFrame ? "frame" : "upload");
	const [pending, setPending] = useState<Pending>(null);
	const busy = pending !== null;

	const videoRef = useRef<HTMLVideoElement>(null);
	const tablistRef = useRef<HTMLDivElement>(null);
	const [videoState, setVideoState] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [duration, setDuration] = useState(0);
	const [frameTime, setFrameTime] = useState(0);

	const [image, setImage] = useState<PreparedImage | null>(null);
	const [preparing, setPreparing] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		if (!open) return;
		setMode(canPickFrame ? "frame" : "upload");
		setVideoState("loading");
		setImageError(null);
		setImage((previous) => {
			if (previous) URL.revokeObjectURL(previous.previewUrl);
			return null;
		});
	}, [open, canPickFrame]);

	useEffect(
		() => () => {
			if (image) URL.revokeObjectURL(image.previewUrl);
		},
		[image],
	);

	const seekTo = useCallback((time: number) => {
		setFrameTime(time);
		const video = videoRef.current;
		if (video && Number.isFinite(time)) video.currentTime = time;
	}, []);

	const handleLoadedMetadata = () => {
		const video = videoRef.current;
		if (!video) return;
		const length = Number.isFinite(video.duration) ? video.duration : 0;
		setDuration(length);
		const start =
			typeof initialFrameTime === "number"
				? Math.min(initialFrameTime, length)
				: Math.min(1, length / 10);
		seekTo(start);
		setVideoState("ready");
	};

	const chooseFile = async (file: File | undefined) => {
		if (!file) return;
		const invalid = validateThumbnailSourceFile(file);
		if (invalid) {
			setImageError(invalid);
			return;
		}
		setImageError(null);
		setPreparing(true);
		try {
			const prepared = await prepareThumbnailImage(file);
			setImage((previous) => {
				if (previous) URL.revokeObjectURL(previous.previewUrl);
				return prepared;
			});
		} catch {
			setImageError("That image couldn't be read. Try a PNG or JPEG.");
		} finally {
			setPreparing(false);
		}
	};

	const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
		event.preventDefault();
		setDragging(false);
		void chooseFile(event.dataTransfer.files[0]);
	};

	const finish = (message: string) => {
		queryClient.invalidateQueries({
			queryKey: ThumbnailRequest.queryKey(videoId),
		});
		router.refresh();
		toast.success(message);
		onOpenChange(false);
	};

	const handleSave = async () => {
		if (busy) return;
		setPending("save");
		try {
			let result: Awaited<ReturnType<typeof uploadCustomThumbnail>>;
			if (mode === "frame") {
				result = await setCustomThumbnailFromFrame(videoId, frameTime);
			} else {
				if (!image) return;
				const formData = new FormData();
				formData.append("videoId", videoId);
				formData.append("image", image.blob, "thumbnail.jpg");
				result = await uploadCustomThumbnail(formData);
			}
			if (result.success) finish("Thumbnail updated");
			else toast.error(result.error);
		} catch {
			toast.error("Couldn't save the thumbnail");
		} finally {
			setPending(null);
		}
	};

	const handleReset = async () => {
		if (busy) return;
		setPending("reset");
		try {
			const result = await resetCustomThumbnail(videoId);
			if (result.success) finish("Thumbnail reset to automatic");
			else toast.error(result.error);
		} catch {
			toast.error("Couldn't reset the thumbnail");
		} finally {
			setPending(null);
		}
	};

	const canSave =
		!busy &&
		(mode === "frame" ? videoState === "ready" : image !== null && !preparing);

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent
				hideCloseButton
				aria-describedby={undefined}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					tablistRef.current
						?.querySelector<HTMLButtonElement>("[aria-selected=true]")
						?.focus({ preventScroll: true });
				}}
				className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[600px] flex-col overflow-hidden rounded-2xl border border-gray-4 bg-gray-1"
			>
				<header className="flex items-start gap-3 px-6 pb-4 pt-6">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
						<ImageIcon className="size-[18px]" strokeWidth={2} />
					</span>
					<div className="min-w-0 flex-1">
						<DialogTitle className="text-lg font-semibold leading-tight text-gray-12">
							Thumbnail
						</DialogTitle>
						<p className="mt-0.5 text-[13px] text-gray-10">
							Shown on your share page, embeds, link previews and dashboard.
						</p>
					</div>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						disabled={busy}
						aria-label="Close"
						className="-mr-1 rounded-lg p-1 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						<X className="size-5" />
					</button>
				</header>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
					<div
						ref={tablistRef}
						role="tablist"
						aria-label="Thumbnail source"
						className="flex w-fit items-center gap-0.5 rounded-full border border-gray-4 bg-gray-2 p-0.5"
					>
						{(
							[
								{ id: "frame", label: "Pick a frame" },
								{ id: "upload", label: "Upload image" },
							] as const
						).map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={mode === tab.id}
								disabled={busy || (tab.id === "frame" && !canPickFrame)}
								onClick={() => setMode(tab.id)}
								className={clsx(
									"rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:cursor-not-allowed disabled:opacity-50",
									mode === tab.id
										? "bg-gray-1 text-gray-12 shadow-sm"
										: "text-gray-10 hover:text-gray-12",
								)}
							>
								{tab.label}
							</button>
						))}
					</div>

					{canPickFrame && (
						<div
							className={clsx(
								"flex-col gap-3",
								mode === "frame" ? "flex" : "hidden",
							)}
						>
							<div className="relative overflow-hidden rounded-xl border border-gray-4 bg-black aspect-video">
								<video
									ref={videoRef}
									src={`/api/playlist?videoId=${encodeURIComponent(videoId)}&videoType=mp4`}
									muted
									playsInline
									preload="auto"
									onLoadedMetadata={handleLoadedMetadata}
									onError={() => setVideoState("error")}
									className="size-full object-contain"
								/>
								{videoState !== "ready" && (
									<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-white/70">
										{videoState === "loading" ? (
											<>
												<LoaderCircle
													className="size-5 animate-spin"
													aria-hidden
												/>
												Loading video
											</>
										) : (
											<>
												The video couldn't load here.
												<button
													type="button"
													onClick={() => setMode("upload")}
													className="font-medium text-white underline underline-offset-2"
												>
													Upload an image instead
												</button>
											</>
										)}
									</div>
								)}
							</div>
							<div className="flex items-center gap-3">
								<label htmlFor={ids.scrubber} className="sr-only">
									Frame
								</label>
								<input
									id={ids.scrubber}
									type="range"
									min={0}
									max={duration || 0}
									step={0.04}
									value={Math.min(frameTime, duration || 0)}
									disabled={videoState !== "ready" || busy}
									aria-valuetext={formatClockWithHundredths(frameTime)}
									onChange={(event) =>
										seekTo(Number(event.currentTarget.value))
									}
									className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-gray-4 accent-blue-9 disabled:cursor-not-allowed disabled:opacity-50"
								/>
								<span className="w-[4.5rem] shrink-0 text-right text-xs font-medium tabular-nums text-gray-11">
									{formatClockWithHundredths(frameTime)}
								</span>
							</div>
						</div>
					)}
					{mode === "upload" && (
						<div className="flex flex-col gap-2">
							<label
								htmlFor={ids.file}
								onDragOver={(event) => {
									event.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={handleDrop}
								className={clsx(
									"relative flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border text-center transition-colors focus-within:ring-2 focus-within:ring-blue-9",
									image
										? "border-gray-4 bg-black"
										: dragging
											? "border-dashed border-blue-8 bg-blue-2"
											: "border-dashed border-gray-5 bg-gray-2 hover:border-gray-7",
								)}
							>
								<input
									id={ids.file}
									type="file"
									accept={CUSTOM_THUMBNAIL_ACCEPT}
									className="sr-only"
									disabled={busy}
									onChange={(event) => {
										void chooseFile(event.currentTarget.files?.[0]);
										event.currentTarget.value = "";
									}}
								/>
								{image ? (
									// biome-ignore lint/performance/noImgElement: local blob preview
									<img
										src={image.previewUrl}
										alt="New thumbnail"
										className="size-full object-contain"
									/>
								) : preparing ? (
									<LoaderCircle
										className="size-5 animate-spin text-gray-10"
										aria-hidden
									/>
								) : (
									<>
										<span className="flex size-10 items-center justify-center rounded-full bg-gray-1 text-gray-11 shadow-sm">
											<Upload className="size-4" aria-hidden />
										</span>
										<span className="text-[13px] font-medium text-gray-12">
											Drop an image or click to browse
										</span>
										<span className="text-xs text-gray-10">
											PNG, JPEG or WebP. 16:9 looks best.
										</span>
									</>
								)}
							</label>
							{image && (
								<p className="text-xs text-gray-10">
									Click the image to choose another.
								</p>
							)}
							{imageError && (
								<p role="alert" className="text-xs text-red-600">
									{imageError}
								</p>
							)}
						</div>
					)}
					{!canPickFrame && (
						<p className="text-xs text-gray-10">
							Frames can be picked once the video finishes processing.
						</p>
					)}
				</div>

				<footer className="flex items-center gap-2 border-t border-gray-4 px-6 py-4">
					{hasCustomThumbnail && (
						<button
							type="button"
							onClick={() => void handleReset()}
							disabled={busy}
							className="rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
						>
							{pending === "reset" ? "Resetting…" : "Reset to automatic"}
						</button>
					)}
					<div className="ml-auto flex items-center gap-2">
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							disabled={busy}
							className="h-9 rounded-full px-4 text-[13px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void handleSave()}
							disabled={!canSave}
							className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gray-12 px-4 text-[13px] font-semibold text-gray-1 transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
						>
							{pending === "save"
								? "Saving…"
								: mode === "frame"
									? "Use this frame"
									: "Use this image"}
						</button>
					</div>
				</footer>
			</DialogContent>
		</Dialog>
	);
}

export default CustomThumbnailDialog;
