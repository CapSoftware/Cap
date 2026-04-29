import { Popover } from "@kobalte/core/popover";
import { batch } from "solid-js";
import IconCapPadding from "~icons/cap/padding";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";

function hasNoVisibleBackground(source: {
	type: string;
	path?: string | null;
	alpha?: number;
}): boolean {
	if (source.type === "color") {
		return (source.alpha ?? 255) === 0;
	}
	if (source.type === "wallpaper" || source.type === "image") {
		return !source.path;
	}
	return false;
}

export function PaddingPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();

	const handlePaddingChange = (v: number[]) => {
		const value = v[0];
		batch(() => {
			if (
				value > 0 &&
				hasNoVisibleBackground(
					project.background.source as {
						type: string;
						path?: string | null;
						alpha?: number;
					},
				)
			) {
				setProject("background", "source", {
					type: "color",
					value: [255, 255, 255],
					alpha: 255,
				});
			}
			setProject("background", "padding", value);
		});
	};

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "padding"}
			onOpenChange={(open) => {
				if (!open && activePopover() === "padding") setActivePopover(null);
			}}
		>
			<Popover.Anchor
				as={EditorButton}
				onClick={() =>
					setActivePopover(activePopover() === "padding" ? null : "padding")
				}
				leftIcon={<IconCapPadding class="size-4" />}
				tooltipText="Padding"
				kbd={["P"]}
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[200px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div class="flex flex-col gap-2">
						<span class="text-xs font-medium text-gray-11">Padding</span>
						<Slider
							value={[project.background.padding]}
							onChange={handlePaddingChange}
							minValue={0}
							maxValue={100}
							step={1}
							formatTooltip="px"
						/>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
