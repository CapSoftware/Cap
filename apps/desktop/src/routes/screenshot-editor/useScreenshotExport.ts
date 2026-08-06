import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import { useScreenshotEditorContext } from "./context";
import {
	canvasNeedsTransparency,
	canvasToBlob,
	copyCurrentScreenshotShareLink,
	renderScreenshotExportCanvas,
	type ScreenshotExportStatus,
	screenshotProjectFingerprint,
	uploadScreenshotShareBlob,
} from "./screenshotExport";

function withWhiteBackground(source: HTMLCanvasElement): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = source.width;
	canvas.height = source.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return source;
	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(source, 0, 0);
	return canvas;
}

export function useScreenshotExport() {
	const editorCtx = useScreenshotEditorContext();
	const {
		latestFrame,
		annotations,
		dialog,
		setDialog,
		project,
		previewCanvas,
		previewMaskCanvas,
		configRevision,
		originalImageSize,
	} = editorCtx;
	const [isExporting, setIsExporting] = createSignal(false);
	const [exportStatus, setExportStatus] =
		createSignal<ScreenshotExportStatus>("idle");

	const canUsePreviewFrameForExport = (
		frame: ReturnType<typeof latestFrame>,
	) => {
		if (!frame?.bitmap) return false;

		if (project.aspectRatio === null) {
			return true;
		}

		const crop = project.background.crop;
		const imageSize = originalImageSize();
		const sourceWidth = crop?.size.x ?? imageSize?.width ?? frame.width;
		const sourceHeight = crop?.size.y ?? imageSize?.height ?? frame.height;

		return frame.width >= sourceWidth && frame.height >= sourceHeight;
	};

	const waitForSyncedPreview = async () => {
		const targetRevision = configRevision();
		const initialFrame = latestFrame();

		if (initialFrame?.revision === targetRevision) {
			return initialFrame;
		}

		const deadline = Date.now() + 1500;

		return await new Promise<NonNullable<ReturnType<typeof latestFrame>>>(
			(resolve, reject) => {
				const poll = () => {
					const frame = latestFrame();

					if (frame?.revision === targetRevision) {
						resolve(frame);
						return;
					}

					if (Date.now() >= deadline) {
						reject(new Error("Preview is still updating. Try again."));
						return;
					}

					window.setTimeout(poll, 16);
				};

				poll();
			},
		);
	};

	const renderExportCanvas = async () => {
		const frame = await waitForSyncedPreview();
		const renderedBitmap = await (async () => {
			if (canUsePreviewFrameForExport(frame) && frame.bitmap) {
				return frame.bitmap;
			}

			const renderedBytes = await commands.renderScreenshotForExport();
			const renderedBlob = new Blob([new Uint8Array(renderedBytes)], {
				type: "image/png",
			});
			return await createImageBitmap(renderedBlob);
		})();
		const shouldCloseRenderedBitmap = renderedBitmap !== frame?.bitmap;
		try {
			const livePreviewCanvas = previewCanvas();
			const livePreviewMaskCanvas = previewMaskCanvas();
			const canReusePreviewCanvases =
				canUsePreviewFrameForExport(frame) &&
				!!livePreviewCanvas &&
				!!livePreviewMaskCanvas &&
				livePreviewCanvas.width === renderedBitmap.width &&
				livePreviewCanvas.height === renderedBitmap.height &&
				livePreviewMaskCanvas.width === renderedBitmap.width &&
				livePreviewMaskCanvas.height === renderedBitmap.height;

			return renderScreenshotExportCanvas({
				renderedBitmap,
				project,
				annotations,
				frame,
				previewCanvas: livePreviewCanvas,
				previewMaskCanvas: livePreviewMaskCanvas,
				canReusePreviewCanvases,
			});
		} finally {
			if (shouldCloseRenderedBitmap) {
				renderedBitmap.close();
			}
		}
	};

	const exportImage = async (destination: "file" | "clipboard" | "share") => {
		if (isExporting()) return;

		setIsExporting(true);
		let toastId: string | undefined;
		let shareContext: { projectPath: string; contentHash: string } | null =
			null;

		try {
			if (destination === "share") {
				const projectPath = editorCtx.editorInstance()?.path;
				if (!projectPath) throw new Error("Screenshot is still loading");

				setExportStatus("encoding");
				toastId = toast.loading("Preparing upload");

				const contentHash = await screenshotProjectFingerprint({
					...unwrap(project),
					annotations: unwrap(annotations),
				});
				const copiedLink = await copyCurrentScreenshotShareLink(
					projectPath,
					contentHash,
				);
				if (copiedLink) {
					toast.success("Share link copied to clipboard", { id: toastId });
					setDialog({ ...dialog(), open: false });
					return;
				}

				shareContext = { projectPath, contentHash };
				setExportStatus("rendering");
				toast.loading("Rendering screenshot", { id: toastId });
			} else {
				setExportStatus("rendering");
			}

			const outputCanvas = await renderExportCanvas();
			setExportStatus("encoding");

			if (destination === "share" && toastId) {
				toast.loading("Preparing upload", { id: toastId });
			}

			const needsAlpha =
				destination === "share" || destination === "clipboard"
					? canvasNeedsTransparency(outputCanvas, project)
					: false;
			const blobCanvas =
				destination === "clipboard" && !needsAlpha
					? withWhiteBackground(outputCanvas)
					: outputCanvas;
			const blob =
				destination === "share"
					? await canvasToBlob(
							blobCanvas,
							needsAlpha ? "image/png" : "image/jpeg",
							0.9,
						)
					: await canvasToBlob(blobCanvas, "image/png");

			if (destination === "file") {
				const buffer = await blob.arrayBuffer();
				const uint8Array = new Uint8Array(buffer);
				const savePath = await save({
					filters: [{ name: "PNG Image", extensions: ["png"] }],
					defaultPath: `${editorCtx.prettyName}.png`,
				});
				if (savePath) {
					await writeFile(savePath, uint8Array);
					toast.success("Screenshot saved!");
					setDialog({ ...dialog(), open: false });
				}
			} else if (destination === "clipboard") {
				const clipboardItem =
					typeof ClipboardItem !== "undefined"
						? new ClipboardItem({ "image/png": blob })
						: null;

				try {
					if (!clipboardItem || !navigator.clipboard?.write) {
						throw new Error("ClipboardItem unavailable");
					}
					await navigator.clipboard.write([clipboardItem]);
				} catch {
					const buffer = await blob.arrayBuffer();
					const uint8Array = new Uint8Array(buffer);
					await commands.copyImageToClipboard(Array.from(uint8Array));
				}
				toast.success("Screenshot copied to clipboard!");
				setDialog({ ...dialog(), open: false });
			} else {
				setExportStatus("uploading");
				if (toastId) toast.loading("Uploading screenshot", { id: toastId });
				if (!shareContext) throw new Error("Screenshot is still loading");
				await uploadScreenshotShareBlob(
					blob,
					shareContext.projectPath,
					shareContext.contentHash,
				);
				toast.success("Share link copied to clipboard", { id: toastId });
				setDialog({ ...dialog(), open: false });
			}
		} catch (err) {
			console.error(err);
			const message = err instanceof Error ? err.message : String(err);
			toast.error(
				message || "Failed to export",
				toastId ? { id: toastId } : {},
			);
		} finally {
			setExportStatus("idle");
			setIsExporting(false);
		}
	};

	return { exportImage, exportStatus, isExporting };
}
