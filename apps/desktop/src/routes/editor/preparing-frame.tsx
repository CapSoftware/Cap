import { createEffect, onCleanup, Show } from "solid-js";
import { usePreparingEditor } from "./preparing-editor-context";

export function PreparingFrame(props: { fallback?: boolean } = {}) {
	const session = usePreparingEditor();
	let host!: HTMLDivElement;
	createEffect(() => {
		const pair = session?.canvases();
		if (!pair) return;
		host.append(pair.active, pair.retained);
		onCleanup(() => {
			if (pair.active.parentElement === host) pair.active.remove();
			if (pair.retained.parentElement === host) pair.retained.remove();
		});
	});
	return (
		<div
			ref={host}
			class="relative flex items-center justify-center w-full h-full min-h-0"
		>
			<Show
				when={
					props.fallback !== false &&
					!session?.model.rendered() &&
					!session?.retained()
				}
			>
				<div class="flex flex-col gap-3 justify-center items-center w-full max-w-[85%] rounded-md aspect-video bg-ed-ctl">
					<IconCapLogo class="size-12 text-ed-text-3 opacity-50" />
				</div>
			</Show>
		</div>
	);
}
