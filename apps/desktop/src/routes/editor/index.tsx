import { Suspense } from "solid-js";
import { Editor } from "./Editor";
import { EditorSkeleton } from "./editor-skeleton";

export default function () {
	return (
		<div class="flex flex-col w-screen h-screen dark:bg-gray-1 bg-gray-2">
			<Suspense fallback={<EditorSkeleton />}>
				<Editor />
			</Suspense>
		</div>
	);
}
