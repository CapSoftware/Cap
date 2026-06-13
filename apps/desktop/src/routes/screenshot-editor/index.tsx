import { ScreenshotEditorProvider } from "./context";
import { Editor } from "./Editor";

export default function ScreenshotEditorRoute() {
	return (
		<div class="flex flex-col w-screen h-screen dark:bg-gray-1 bg-gray-2">
			<ScreenshotEditorProvider>
				<Editor />
			</ScreenshotEditorProvider>
		</div>
	);
}
