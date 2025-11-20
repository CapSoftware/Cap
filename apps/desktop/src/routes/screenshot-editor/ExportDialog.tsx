import { Button } from "@cap/ui-solid";
import IconCapCopy from "~icons/cap/copy";
import IconCapFile from "~icons/cap/file";
import { DialogContent } from "./ui";
import { useScreenshotExport } from "./useScreenshotExport";

export function ExportDialog() {
	const { exportImage, isExporting } = useScreenshotExport();

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
						disabled={isExporting()}
					>
						<IconCapFile class="size-5" />
						Save to File
					</Button>
					<Button
						variant="gray"
						class="flex-1 flex gap-2 items-center justify-center h-12"
						onClick={() => exportImage("clipboard")}
						disabled={isExporting()}
					>
						<IconCapCopy class="size-5" />
						Copy to Clipboard
					</Button>
				</div>
			</div>
		</DialogContent>
	);
}
