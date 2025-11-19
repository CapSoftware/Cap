import { Button } from "@cap/ui-solid";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import IconCapCircleX from "~icons/cap/circle-x";
import IconCapCopy from "~icons/cap/copy";
import IconCapFile from "~icons/cap/file";
import { useScreenshotEditorContext } from "./context";
import { Dialog, DialogContent } from "./ui";

export function ExportDialog() {
	const { dialog, setDialog, path, project } = useScreenshotEditorContext();
	const [exporting, setExporting] = createSignal(false);

	const exportImage = async (destination: "file" | "clipboard") => {
		setExporting(true);
		try {
			// 1. Load the image
			const img = new Image();
			img.src = convertFileSrc(path);
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = reject;
			});

			// 2. Create canvas with appropriate dimensions
			// We need to account for padding, crop, etc.
			// For now, let's assume simple export of the original image + background settings
			// This is a simplified implementation. A robust one would replicate the CSS effects on canvas.

			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Could not get canvas context");

			// Calculate dimensions based on project settings
			// This logic needs to match Preview.tsx
			const padding = project.background.padding * 2; // Scale factor?
			// In Preview.tsx: padding: `${padding * 2}px`
			// But here we are working with actual pixels.
			// Let's assume padding is in pixels relative to the image size?
			// Or we need a consistent scale.
			// For simplicity, let's just use the image size + padding.

			// TODO: Implement proper rendering logic matching CSS
			// For now, we'll just export the original image to demonstrate the flow
			canvas.width = img.width;
			canvas.height = img.height;
			ctx.drawImage(img, 0, 0);

			// 3. Export
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/png"),
			);
			if (!blob) throw new Error("Failed to create blob");

			const buffer = await blob.arrayBuffer();
			const uint8Array = new Uint8Array(buffer);

			if (destination === "file") {
				const savePath = await save({
					filters: [{ name: "PNG Image", extensions: ["png"] }],
					defaultPath: "screenshot.png",
				});
				if (savePath) {
					await commands.writeFile(savePath, Array.from(uint8Array));
					toast.success("Screenshot saved!");
				}
			} else {
				// Copy to clipboard
				// We need a command for this as web API might be limited
				// commands.copyImageToClipboard(uint8Array)?
				// For now, let's use the existing command if it supports data
				// commands.copyScreenshotToClipboard(path) copies the file at path.
				// If we want to copy the *edited* image, we need to save it to a temp file first or send bytes.

				// Fallback to copying the original file for now
				await commands.copyScreenshotToClipboard(path);
				toast.success(
					"Original screenshot copied to clipboard (editing export WIP)",
				);
			}

			setDialog({ ...dialog(), open: false });
		} catch (err) {
			console.error(err);
			toast.error("Failed to export");
		} finally {
			setExporting(false);
		}
	};

	return (
		<DialogContent
			title="Export Screenshot"
			confirm={null} // Custom footer
		>
			<div class="flex flex-col gap-4">
				<p class="text-gray-11 text-sm">
					Choose where to export your screenshot.
				</p>
				<div class="flex gap-3">
					<Button
						variant="gray"
						class="flex-1 flex gap-2 items-center justify-center h-12"
						onClick={() => exportImage("file")}
						disabled={exporting()}
					>
						<IconCapFile class="size-5" />
						Save to File
					</Button>
					<Button
						variant="gray"
						class="flex-1 flex gap-2 items-center justify-center h-12"
						onClick={() => exportImage("clipboard")}
						disabled={exporting()}
					>
						<IconCapCopy class="size-5" />
						Copy to Clipboard
					</Button>
				</div>
			</div>
		</DialogContent>
	);
}
