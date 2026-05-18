import { Popover } from "@kobalte/core/popover";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import { batch, Show, type ValidComponent } from "solid-js";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCorners from "~icons/cap/corners";
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

export function RoundingPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();

	const handleRoundingChange = (v: number[]) => {
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
				if (project.background.padding === 0) {
					setProject("background", "padding", 10);
				}
			}
			setProject("background", "rounding", value);
		});
	};

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "rounding"}
			onOpenChange={(open) => {
				if (!open && activePopover() === "rounding") setActivePopover(null);
			}}
		>
			<Popover.Anchor
				as={EditorButton}
				onClick={() =>
					setActivePopover(activePopover() === "rounding" ? null : "rounding")
				}
				leftIcon={<IconCapCorners class="size-4" />}
				tooltipText="Corner Rounding"
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[240px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium text-gray-11 inline-flex gap-2 items-center">
									<IconCapCorners class="size-4" />
									Rounding
								</span>
								<Slider
									value={[project.background.rounding]}
									onChange={(v) => setProject("background", "rounding", v[0])}
									minValue={0}
									maxValue={100}
									step={0.1}
									formatTooltip="%"
								/>
							</div>
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium text-gray-11 inline-flex gap-2 items-center">
									<IconLucideSquareRoundCorner class="size-4" />
									Rounding Smoothness
								</span>
								<Slider
									value={[project.background.roundingSmoothness ?? 0]}
									onChange={(v) =>
										setProject("background", "roundingSmoothness", v[0])
									}
									minValue={0}
									maxValue={1}
									step={0.01}
									formatTooltip={(value) => `${Math.round(value * 100)}%`}
								/>
							</div>
						</div>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
