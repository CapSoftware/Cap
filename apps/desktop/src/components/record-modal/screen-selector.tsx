import { type Component, For, createSignal, onMount } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { listScreens } from "~/utils/queries";
import type { CaptureDisplay } from "~/utils/tauri";

export interface ScreenSelectorProps {
	selectedDisplayId?: number;
	onSelect?: (display: CaptureDisplay) => void;
	class?: string;
}

export const ScreenSelector: Component<ScreenSelectorProps> = (props) => {
	const displaysQuery = useQuery(() => listScreens);
	const [selectedId, setSelectedId] = createSignal<number | undefined>(props.selectedDisplayId);

	onMount(() => {
		const displays = displaysQuery.data || [];
		if (displays.length > 0 && selectedId() === undefined) {
			const primary = displays[0];
			setSelectedId(primary.id);
			props.onSelect?.(primary);
		}
	});

	return (
		<div class={`screen-selector flex items-center gap-1.5 ${props.class || ""}`}>
			<For each={displaysQuery.data}>
				{(display) => (
					<button
						type="button"
						aria-pressed={selectedId() === display.id}
						class={`px-2.5 py-1 rounded text-xs font-medium transition-colors inline-flex items-center gap-1 ${
							selectedId() === display.id
								? "bg-blue-600 text-white"
								: "bg-gray-800 text-gray-300 hover:bg-gray-700"
						}`}
						onClick={() => {
							setSelectedId(display.id);
							props.onSelect?.(display);
						}}
					>
						{selectedId() === display.id && <span class="text-xs">✓</span>}
						<span>{display.name}</span>
					</button>
				)}
			</For>
		</div>
	);
};

export default ScreenSelector;
