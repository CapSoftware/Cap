"use client";

import { Dialog, DialogContent, DialogTitle } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import {
	Film,
	ImageUp,
	Link2,
	RotateCcw,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	resetLinkPreview,
	saveLinkPreview,
} from "@/actions/videos/link-preview";
import {
	DEFAULT_LINK_PREVIEW_DESCRIPTION,
	defaultLinkPreviewTitle,
	LINK_PREVIEW_DESCRIPTION_MAX_LENGTH,
	LINK_PREVIEW_DESCRIPTION_SHOWN_LENGTH,
	LINK_PREVIEW_IMAGE_HEIGHT,
	LINK_PREVIEW_IMAGE_MIN_HEIGHT,
	LINK_PREVIEW_IMAGE_MIN_WIDTH,
	LINK_PREVIEW_IMAGE_WIDTH,
	LINK_PREVIEW_TITLE_MAX_LENGTH,
	LINK_PREVIEW_TITLE_SHOWN_LENGTH,
	type LinkPreviewErrors,
	type LinkPreviewState,
	sanitizeLinkPreviewText,
} from "@/lib/share-link-preview";
import {
	UNFURL_APPS,
	type UnfurlApp,
	UnfurlCard,
	type UnfurlContent,
} from "./LinkPreviewCards";
import {
	type CropState,
	captureVideoFrame,
	cropBackgroundStyle,
	DEFAULT_CROP,
	MAX_ZOOM,
	MIN_ZOOM,
	panCrop,
	renderCroppedImage,
	type Size,
} from "./link-preview-crop";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const PREVIEW_SIZE: Size = { width: 600, height: 315 };

type ImageChoice =
	| { kind: "default" }
	| { kind: "stored"; url: string }
	| {
			kind: "new";
			src: string;
			element: HTMLImageElement;
			size: Size;
			crop: CropState;
	  };

const APP_CAPTIONS: Record<UnfurlApp, string> = {
	imessage: "iMessage shows the image, the title and where the link goes.",
	slack: "Slack adds your description under the title.",
	x: "X lays the title over the image.",
};

const initialImage = (linkPreview: LinkPreviewState | null): ImageChoice =>
	linkPreview?.imageUrl
		? { kind: "stored", url: linkPreview.imageUrl }
		: { kind: "default" };

const loadImage = (src: string) =>
	new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("That image couldn't be opened"));
		image.src = src;
	});

const findSharePlayer = () =>
	document.querySelector<HTMLVideoElement>("[data-edit-video] video") ??
	document.querySelector<HTMLVideoElement>("video");

export function LinkPreviewDialog({
	open,
	onOpenChange,
	videoId,
	videoName,
	ownerName,
	host,
	linkPreview,
	canEdit,
	onSaved,
	onUpgradeRequest,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	videoId: Video.VideoId;
	videoName: string;
	ownerName: string;
	host: string;
	linkPreview: LinkPreviewState | null;
	canEdit: boolean;
	onSaved?: (linkPreview: LinkPreviewState | null) => void;
	onUpgradeRequest: () => void;
}) {
	const [title, setTitle] = useState(linkPreview?.title ?? "");
	const [description, setDescription] = useState(
		linkPreview?.description ?? "",
	);
	const [image, setImage] = useState<ImageChoice>(() =>
		initialImage(linkPreview),
	);
	const [cardImageUrl, setCardImageUrl] = useState<string | null>(null);
	const [errors, setErrors] = useState<LinkPreviewErrors>({});
	const [pending, setPending] = useState<"save" | "reset" | null>(null);
	const [grabbingFrame, setGrabbingFrame] = useState(false);
	const [hasPlayer, setHasPlayer] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [dropActive, setDropActive] = useState(false);
	const [app, setApp] = useState<UnfurlApp>("imessage");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const frameRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(
		null,
	);
	const objectUrlsRef = useRef<string[]>([]);
	const ids = {
		title: useId(),
		description: useId(),
		zoom: useId(),
		form: useId(),
	};

	const defaultImageUrl = `/api/video/og?videoId=${encodeURIComponent(videoId)}`;
	const busy = pending !== null || grabbingFrame;
	const hasOverrides = linkPreview !== null;

	const revokeObjectUrls = useCallback(() => {
		for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
		objectUrlsRef.current = [];
	}, []);

	useEffect(() => revokeObjectUrls, [revokeObjectUrls]);

	const wasOpenRef = useRef(false);
	useEffect(() => {
		const opening = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!opening) return;
		revokeObjectUrls();
		setTitle(linkPreview?.title ?? "");
		setDescription(linkPreview?.description ?? "");
		setImage(initialImage(linkPreview));
		setCardImageUrl(null);
		setErrors({});
		setPending(null);
		setHasPlayer(findSharePlayer() !== null);
	}, [open, linkPreview, revokeObjectUrls]);

	// The cards show the crop as it will be saved, redrawn once the image
	// settles rather than on every pointer move.
	useEffect(() => {
		if (image.kind !== "new" || dragging) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			renderCroppedImage(image.element, image.size, image.crop, PREVIEW_SIZE)
				.then((blob) => {
					if (cancelled) return;
					const url = URL.createObjectURL(blob);
					objectUrlsRef.current.push(url);
					setCardImageUrl(url);
				})
				.catch(() => {});
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [image, dragging]);

	const cardImage =
		image.kind === "stored"
			? image.url
			: image.kind === "new"
				? (cardImageUrl ?? image.src)
				: defaultImageUrl;

	const content: UnfurlContent = {
		title: sanitizeLinkPreviewText(title) || defaultLinkPreviewTitle(videoName),
		description:
			sanitizeLinkPreviewText(description) || DEFAULT_LINK_PREVIEW_DESCRIPTION,
		host,
		imageUrl: cardImage,
		ownerName: ownerName || "You",
	};

	const adoptSourceImage = async (src: string) => {
		try {
			const element = await loadImage(src);
			const size = {
				width: element.naturalWidth,
				height: element.naturalHeight,
			};
			if (
				size.width < LINK_PREVIEW_IMAGE_MIN_WIDTH ||
				size.height < LINK_PREVIEW_IMAGE_MIN_HEIGHT
			) {
				setErrors((previous) => ({
					...previous,
					image: `Choose an image at least ${LINK_PREVIEW_IMAGE_MIN_WIDTH} × ${LINK_PREVIEW_IMAGE_MIN_HEIGHT}`,
				}));
				return;
			}
			setCardImageUrl(null);
			setImage({ kind: "new", src, element, size, crop: DEFAULT_CROP });
			setErrors((previous) => ({ ...previous, image: undefined }));
		} catch (error) {
			setErrors((previous) => ({
				...previous,
				image:
					error instanceof Error
						? error.message
						: "That image couldn't be opened",
			}));
		}
	};

	const handleFile = (file: File | undefined) => {
		if (!file) return;
		if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
			setErrors((previous) => ({
				...previous,
				image: "Choose a JPEG, PNG or WebP image",
			}));
			return;
		}
		if (file.size > MAX_SOURCE_BYTES) {
			setErrors((previous) => ({
				...previous,
				image: "Choose an image under 20 MB",
			}));
			return;
		}
		const url = URL.createObjectURL(file);
		objectUrlsRef.current.push(url);
		void adoptSourceImage(url);
	};

	const handleUseFrame = async () => {
		const video = findSharePlayer();
		if (!video) return;
		setGrabbingFrame(true);
		try {
			const frame = await captureVideoFrame(video);
			objectUrlsRef.current.push(frame.url);
			await adoptSourceImage(frame.url);
		} catch {
			setErrors((previous) => ({
				...previous,
				image:
					"Couldn't grab this frame. Pause on the moment you want, or upload an image instead.",
			}));
		} finally {
			setGrabbingFrame(false);
		}
	};

	const updateCrop = (next: (crop: CropState, size: Size) => CropState) =>
		setImage((current) =>
			current.kind === "new"
				? { ...current, crop: next(current.crop, current.size) }
				: current,
		);

	const frameSize = (): Size => {
		const rect = frameRef.current?.getBoundingClientRect();
		return {
			width: rect?.width || PREVIEW_SIZE.width,
			height: rect?.height || PREVIEW_SIZE.height,
		};
	};

	const handleSave = async () => {
		const formData = new FormData();
		formData.set("videoId", videoId);
		formData.set("title", title);
		formData.set("description", description);
		setPending("save");
		try {
			if (image.kind === "new") {
				const blob = await renderCroppedImage(
					image.element,
					image.size,
					image.crop,
				);
				formData.set(
					"image",
					new File([blob], "link-preview.jpg", { type: "image/jpeg" }),
				);
			} else if (image.kind === "default" && linkPreview?.imageUrl) {
				formData.set("removeImage", "1");
			}

			const response = await saveLinkPreview(formData);
			if (!response.success) {
				if (response.upgradeRequired) {
					onOpenChange(false);
					onUpgradeRequest();
					return;
				}
				setErrors(response.errors);
				return;
			}
			toast.success(
				response.linkPreview ? "Link preview saved" : "Link preview reset",
			);
			onSaved?.(response.linkPreview);
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error && error.message.startsWith("That image")
					? error.message
					: "Couldn't save your link preview",
			);
		} finally {
			setPending(null);
		}
	};

	const handleReset = async () => {
		setPending("reset");
		try {
			await resetLinkPreview(videoId);
			toast.success("Link preview reset");
			onSaved?.(null);
			onOpenChange(false);
		} catch {
			toast.error("Couldn't reset your link preview");
		} finally {
			setPending(null);
		}
	};

	const titleLength = sanitizeLinkPreviewText(title).length;
	const descriptionLength = sanitizeLinkPreviewText(description).length;

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent
				hideCloseButton
				aria-describedby={undefined}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					if (canEdit) titleInputRef.current?.focus();
				}}
				className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[960px] flex-col overflow-y-auto overscroll-contain rounded-2xl border border-gray-4 bg-gray-1 md:flex-row md:overflow-hidden"
			>
				<section className="relative flex shrink-0 flex-col gap-4 border-b border-gray-4 bg-gray-2 p-4 sm:p-5 md:w-[50%] md:border-b-0 md:border-r md:p-6">
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs font-medium text-gray-10">Preview</p>
						<div
							role="tablist"
							aria-label="Preview app"
							className="flex items-center gap-0.5 rounded-full border border-gray-4 bg-gray-1 p-0.5"
						>
							{UNFURL_APPS.map((option) => (
								<button
									key={option.id}
									type="button"
									role="tab"
									aria-selected={app === option.id}
									onClick={() => setApp(option.id)}
									className={clsx(
										"relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
										app === option.id
											? "text-gray-12"
											: "text-gray-10 hover:text-gray-12",
									)}
								>
									{app === option.id && (
										<motion.span
											layoutId="link-preview-app"
											className="absolute inset-0 rounded-full bg-gray-4"
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 38,
											}}
										/>
									)}
									<span className="relative">{option.label}</span>
								</button>
							))}
						</div>
					</div>

					<div className="flex flex-1 flex-col justify-center gap-3">
						<div className="flex min-h-[180px] items-center justify-center rounded-xl border border-gray-4 bg-gray-1 p-4 sm:p-6 md:min-h-[340px]">
							<AnimatePresence mode="wait" initial={false}>
								<motion.div
									key={app}
									className="flex w-full justify-center"
									initial={{ opacity: 0, y: 4 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -4 }}
									transition={{ duration: 0.16 }}
									aria-hidden
								>
									<UnfurlCard app={app} content={content} />
								</motion.div>
							</AnimatePresence>
						</div>
						<p className="text-[13px] leading-relaxed text-gray-10 max-md:hidden">
							{APP_CAPTIONS[app]} Apps keep a copy for a while, so a link
							already shared may take time to update.
						</p>
					</div>
				</section>

				<section className="flex flex-none flex-col md:min-h-0 md:flex-1">
					<header className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
							<Link2 className="size-[18px]" strokeWidth={2} />
						</span>
						<div className="min-w-0 flex-1">
							<DialogTitle className="text-lg font-semibold leading-tight text-gray-12">
								Link preview
							</DialogTitle>
							<p className="mt-0.5 text-[13px] text-gray-10">
								Choose what people see when you share this link.
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

					<form
						id={ids.form}
						className="flex flex-1 flex-col gap-5 px-5 pb-6 sm:px-6 md:min-h-0 md:overflow-y-auto [&>*]:shrink-0"
						onSubmit={(event) => {
							event.preventDefault();
							if (canEdit) void handleSave();
						}}
					>
						{!canEdit && (
							<div className="flex flex-col gap-3 rounded-xl border border-gray-4 bg-gray-2 p-4 sm:flex-row sm:items-center">
								<p className="min-w-0 flex-1 text-[13px] leading-relaxed text-gray-11">
									Custom link previews are part of Cap Pro.
									{hasOverrides
										? " Your saved preview is paused and comes back when you upgrade, or you can reset it."
										: ""}
								</p>
								<button
									type="button"
									onClick={() => {
										onOpenChange(false);
										onUpgradeRequest();
									}}
									className="h-8 shrink-0 rounded-full bg-gray-12 px-3.5 text-[13px] font-semibold text-gray-1 transition-opacity hover:opacity-90"
								>
									Upgrade to Pro
								</button>
							</div>
						)}

						<div className="flex flex-col gap-2">
							<div className="flex items-baseline justify-between gap-2">
								<p className="text-[13px] font-medium text-gray-12">Image</p>
								<span className="text-[11px] tabular-nums text-gray-9">
									{LINK_PREVIEW_IMAGE_WIDTH} × {LINK_PREVIEW_IMAGE_HEIGHT}
								</span>
							</div>
							<ImageFrame
								frameRef={frameRef}
								image={image}
								defaultImageUrl={defaultImageUrl}
								editable={canEdit && !busy}
								dragging={dragging}
								dropActive={dropActive}
								onDropActiveChange={setDropActive}
								onFile={handleFile}
								onPointerDown={(event) => {
									if (image.kind !== "new" || !canEdit) return;
									event.currentTarget.setPointerCapture(event.pointerId);
									dragRef.current = {
										x: event.clientX,
										y: event.clientY,
										pointerId: event.pointerId,
									};
									setDragging(true);
								}}
								onPointerMove={(event) => {
									const start = dragRef.current;
									if (!start || start.pointerId !== event.pointerId) return;
									const deltaX = event.clientX - start.x;
									const deltaY = event.clientY - start.y;
									dragRef.current = {
										...start,
										x: event.clientX,
										y: event.clientY,
									};
									const frame = frameSize();
									updateCrop((crop, size) =>
										panCrop(size, crop, frame, deltaX, deltaY),
									);
								}}
								onPointerEnd={(event) => {
									if (dragRef.current?.pointerId !== event.pointerId) return;
									dragRef.current = null;
									setDragging(false);
								}}
								onKeyNudge={(deltaX, deltaY) => {
									const frame = frameSize();
									updateCrop((crop, size) =>
										panCrop(size, crop, frame, deltaX, deltaY),
									);
								}}
							/>
							{image.kind === "new" && canEdit && (
								<div className="flex items-center gap-3">
									<p className="shrink-0 text-xs text-gray-10">
										Drag to reposition
									</p>
									<label
										htmlFor={ids.zoom}
										className="ml-auto flex min-w-0 flex-1 items-center gap-2 sm:max-w-[200px]"
									>
										<span className="sr-only">Zoom</span>
										<ZoomOut className="size-3.5 shrink-0 text-gray-9" />
										<input
											id={ids.zoom}
											type="range"
											min={MIN_ZOOM}
											max={MAX_ZOOM}
											step={0.01}
											value={image.crop.zoom}
											onChange={(event) => {
												const zoom = Number(event.target.value);
												updateCrop((crop) => ({ ...crop, zoom }));
											}}
											className="h-1 min-w-0 flex-1 cursor-pointer accent-gray-12"
										/>
										<ZoomIn className="size-3.5 shrink-0 text-gray-9" />
									</label>
								</div>
							)}
							{canEdit && (
								<div className="flex flex-wrap items-center gap-1.5 pt-0.5">
									<ChipButton
										onClick={() => fileInputRef.current?.click()}
										disabled={busy}
										icon={<ImageUp className="size-3.5" />}
									>
										{image.kind === "default" ? "Upload image" : "Replace"}
									</ChipButton>
									{hasPlayer && (
										<ChipButton
											onClick={() => void handleUseFrame()}
											disabled={busy}
											icon={<Film className="size-3.5" />}
										>
											{grabbingFrame ? "Grabbing…" : "Use current frame"}
										</ChipButton>
									)}
									{image.kind !== "default" && (
										<ChipButton
											onClick={() => {
												setImage({ kind: "default" });
												setErrors((previous) => ({
													...previous,
													image: undefined,
												}));
											}}
											disabled={busy}
											icon={<RotateCcw className="size-3.5" />}
										>
											Use default
										</ChipButton>
									)}
									<input
										ref={fileInputRef}
										type="file"
										accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic"
										className="sr-only"
										tabIndex={-1}
										aria-hidden
										onChange={(event) => {
											handleFile(event.target.files?.[0]);
											event.target.value = "";
										}}
									/>
								</div>
							)}
							<FieldError error={errors.image} />
							{canEdit && !errors.image && (
								<p className="text-xs leading-relaxed text-gray-10">
									Wide images work best. Keep text and faces near the middle,
									since some apps trim the edges.
								</p>
							)}
						</div>

						<Field
							id={ids.title}
							label="Title"
							error={errors.title}
							hint={
								titleLength > LINK_PREVIEW_TITLE_SHOWN_LENGTH
									? "Longer titles get cut off in most apps"
									: undefined
							}
							counter={`${titleLength}/${LINK_PREVIEW_TITLE_SHOWN_LENGTH}`}
							over={titleLength > LINK_PREVIEW_TITLE_SHOWN_LENGTH}
						>
							<input
								ref={titleInputRef}
								id={ids.title}
								type="text"
								value={title}
								disabled={!canEdit || busy}
								placeholder={defaultLinkPreviewTitle(videoName)}
								maxLength={LINK_PREVIEW_TITLE_MAX_LENGTH}
								autoComplete="off"
								aria-invalid={Boolean(errors.title) || undefined}
								onChange={(event) => {
									setTitle(event.target.value);
									if (errors.title)
										setErrors((previous) => ({
											...previous,
											title: undefined,
										}));
								}}
								className={inputClass(Boolean(errors.title))}
							/>
						</Field>

						<Field
							id={ids.description}
							label="Description"
							error={errors.description}
							hint={
								descriptionLength > LINK_PREVIEW_DESCRIPTION_SHOWN_LENGTH
									? "Most apps show the first couple of lines"
									: undefined
							}
							counter={`${descriptionLength}/${LINK_PREVIEW_DESCRIPTION_SHOWN_LENGTH}`}
							over={descriptionLength > LINK_PREVIEW_DESCRIPTION_SHOWN_LENGTH}
						>
							<textarea
								id={ids.description}
								value={description}
								disabled={!canEdit || busy}
								rows={3}
								placeholder={DEFAULT_LINK_PREVIEW_DESCRIPTION}
								maxLength={LINK_PREVIEW_DESCRIPTION_MAX_LENGTH}
								aria-invalid={Boolean(errors.description) || undefined}
								onChange={(event) => {
									setDescription(event.target.value);
									if (errors.description)
										setErrors((previous) => ({
											...previous,
											description: undefined,
										}));
								}}
								className={clsx(
									inputClass(Boolean(errors.description)),
									"h-auto resize-none py-2.5 leading-relaxed",
								)}
							/>
						</Field>
					</form>

					<footer className="sticky bottom-0 flex shrink-0 items-center gap-2 border-t border-gray-4 bg-gray-1 px-5 py-4 sm:px-6">
						{hasOverrides && (
							<button
								type="button"
								onClick={() => void handleReset()}
								disabled={busy}
								className="rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
							>
								{pending === "reset" ? "Resetting…" : "Reset to default"}
							</button>
						)}
						<div className="ml-auto flex items-center gap-2">
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								disabled={busy}
								className="h-9 rounded-full px-4 text-[13px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
							>
								{canEdit ? "Cancel" : "Close"}
							</button>
							{canEdit && (
								<button
									type="submit"
									form={ids.form}
									disabled={busy}
									className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gray-12 px-4 text-[13px] font-semibold text-gray-1 transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
								>
									{pending === "save" ? "Saving…" : "Save"}
								</button>
							)}
						</div>
					</footer>
				</section>
			</DialogContent>
		</Dialog>
	);
}

const inputClass = (invalid: boolean) =>
	clsx(
		"h-10 w-full rounded-xl border bg-gray-1 px-3 text-[14px] text-gray-12 outline-none transition-[border-color,box-shadow] placeholder:text-gray-8 disabled:cursor-not-allowed disabled:bg-gray-2 disabled:text-gray-10",
		invalid
			? "border-red-400 focus:border-red-500 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15)]"
			: "border-gray-4 hover:border-gray-6 focus:border-blue-8 focus:shadow-[0_0_0_3px_rgba(47,107,255,0.15)]",
	);

function ImageFrame({
	frameRef,
	image,
	defaultImageUrl,
	editable,
	dragging,
	dropActive,
	onDropActiveChange,
	onFile,
	onPointerDown,
	onPointerMove,
	onPointerEnd,
	onKeyNudge,
}: {
	frameRef: React.RefObject<HTMLDivElement | null>;
	image: ImageChoice;
	defaultImageUrl: string;
	editable: boolean;
	dragging: boolean;
	dropActive: boolean;
	onDropActiveChange: (active: boolean) => void;
	onFile: (file: File | undefined) => void;
	onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
	onKeyNudge: (deltaX: number, deltaY: number) => void;
}) {
	const pannable = image.kind === "new" && editable;
	const style =
		image.kind === "new"
			? {
					backgroundImage: `url(${JSON.stringify(image.src)})`,
					...cropBackgroundStyle(image.size, image.crop),
				}
			: {
					backgroundImage: `url(${JSON.stringify(
						image.kind === "stored" ? image.url : defaultImageUrl,
					)})`,
					backgroundSize: "cover",
					backgroundPosition: "center",
				};

	return (
		<div
			ref={frameRef}
			role="application"
			aria-label={
				pannable
					? "Image crop. Drag or use the arrow keys to reposition."
					: editable
						? "Preview image. Drop an image here to use it."
						: "Preview image"
			}
			tabIndex={pannable ? 0 : undefined}
			style={style}
			className={clsx(
				"relative aspect-[1200/630] w-full touch-none select-none overflow-hidden rounded-xl bg-gray-3 bg-no-repeat ring-1 ring-gray-4 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				pannable && (dragging ? "cursor-grabbing" : "cursor-grab"),
				dropActive && "ring-2 ring-blue-9",
			)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onKeyDown={(event) => {
				if (!pannable) return;
				const step = event.shiftKey ? 40 : 10;
				const moves: Record<string, [number, number]> = {
					ArrowLeft: [step, 0],
					ArrowRight: [-step, 0],
					ArrowUp: [0, step],
					ArrowDown: [0, -step],
				};
				const move = moves[event.key];
				if (!move) return;
				event.preventDefault();
				onKeyNudge(move[0], move[1]);
			}}
			onDragOver={(event) => {
				if (!editable) return;
				event.preventDefault();
				onDropActiveChange(true);
			}}
			onDragLeave={() => onDropActiveChange(false)}
			onDrop={(event) => {
				if (!editable) return;
				event.preventDefault();
				onDropActiveChange(false);
				onFile(event.dataTransfer.files?.[0]);
			}}
		>
			{image.kind === "default" && (
				<span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-md">
					Default image
				</span>
			)}
			{pannable && (
				<div
					aria-hidden
					className={clsx(
						"pointer-events-none absolute inset-0 transition-opacity duration-200",
						dragging ? "opacity-100" : "opacity-0",
					)}
				>
					<div className="absolute inset-y-0 left-1/3 w-px bg-white/45" />
					<div className="absolute inset-y-0 left-2/3 w-px bg-white/45" />
					<div className="absolute inset-x-0 top-1/3 h-px bg-white/45" />
					<div className="absolute inset-x-0 top-2/3 h-px bg-white/45" />
				</div>
			)}
		</div>
	);
}

function ChipButton({
	onClick,
	disabled,
	icon,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-4 bg-gray-1 px-3 text-xs font-medium text-gray-11 transition-colors hover:border-gray-6 hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-50"
		>
			{icon}
			{children}
		</button>
	);
}

function FieldError({ error }: { error?: string }) {
	return (
		<AnimatePresence initial={false}>
			{error && (
				<motion.p
					key={error}
					initial={{ opacity: 0, height: 0 }}
					animate={{ opacity: 1, height: "auto" }}
					exit={{ opacity: 0, height: 0 }}
					transition={{ duration: 0.15 }}
					role="alert"
					className="text-xs text-red-600 dark:text-red-400"
				>
					{error}
				</motion.p>
			)}
		</AnimatePresence>
	);
}

function Field({
	id,
	label,
	error,
	hint,
	counter,
	over,
	children,
}: {
	id: string;
	label: string;
	error?: string;
	hint?: string;
	counter: string;
	over: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-2">
				<label htmlFor={id} className="text-[13px] font-medium text-gray-12">
					{label}
					<span className="ml-1.5 font-normal text-gray-9">Optional</span>
				</label>
				<span
					className={clsx(
						"text-[11px] tabular-nums transition-colors",
						over ? "text-amber-600 dark:text-amber-400" : "text-gray-9",
					)}
				>
					{counter}
				</span>
			</div>
			{children}
			<FieldError error={error} />
			{!error && hint && <p className="text-xs text-gray-10">{hint}</p>}
		</div>
	);
}
