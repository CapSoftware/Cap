import { Popover } from "@kobalte/core/popover";
import IconCapPadding from "~icons/cap/padding";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";

export function PaddingPopover() {
	const { project, setProject } = useScreenshotEditorContext();

	return (
		<Popover placement="bottom-start">
			<Popover.Trigger
				as={EditorButton}
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
							onChange={(v) => setProject("background", "padding", v[0])}
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
