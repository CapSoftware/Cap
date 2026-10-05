import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import { useEditorContext } from "./context";
import { ImageSegmentConfig } from "./image-segment-config";

export function ImageEditorSidebar(props: { index: number }) {
	const { setEditorState } = useEditorContext();
	return (
		<aside class="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl bg-ed-card shadow-ed-card">
			<div class="flex h-[46px] shrink-0 items-center gap-2 border-b border-ed-line px-3">
				<button
					type="button"
					aria-label="Back to editor settings"
					class="flex size-8 items-center justify-center rounded-lg text-ed-text-2 transition-colors hover:bg-ed-ctl hover:text-ed-text-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ed-accent"
					onClick={() => setEditorState("timeline", "selection", null)}
				>
					<IconLucideArrowLeft class="size-4" />
				</button>
				<div class="min-w-0 text-[13px] font-semibold text-ed-text-1">
					Edit image
				</div>
			</div>
			<div class="custom-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
				<ImageSegmentConfig index={props.index} dedicated />
			</div>
		</aside>
	);
}
