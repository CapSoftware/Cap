import { Popover } from "@kobalte/core/popover";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import { batch, Show, type ValidComponent } from "solid-js";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCorners from "~icons/cap/corners";
import { useScreenshotEditorContext } from "../context";
import {
	EditorButton,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	topSlideAnimateClasses,
} from "../ui";

export type CornerRoundingType = "rounded" | "squircle";
const CORNER_STYLE_OPTIONS = [
	{ name: "Squircle", value: "squircle" },
	{ name: "Rounded", value: "rounded" },
] satisfies Array<{ name: string; value: CornerRoundingType }>;

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
							<span class="text-xs font-medium text-gray-11">Rounding</span>
							<Slider
								value={[project.background.rounding]}
								onChange={handleRoundingChange}
								minValue={0}
								maxValue={100}
								step={1}
								formatTooltip="px"
							/>
						</div>
						<CornerStyleSelect
							label="Corner Style"
							value={project.background.roundingType || "squircle"}
							onChange={(v) => setProject("background", "roundingType", v)}
						/>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}

function CornerStyleSelect(props: {
	label?: string;
	value: CornerRoundingType;
	onChange: (value: CornerRoundingType) => void;
}) {
	return (
		<div class="flex flex-col gap-1.5">
			<Show when={props.label}>
				{(label) => (
					<span class="text-[0.65rem] uppercase tracking-wide text-gray-11">
						{label()}
					</span>
				)}
			</Show>
			<KSelect<{ name: string; value: CornerRoundingType }>
				options={CORNER_STYLE_OPTIONS}
				optionValue="value"
				optionTextValue="name"
				value={CORNER_STYLE_OPTIONS.find(
					(option) => option.value === props.value,
				)}
				onChange={(option) => option && props.onChange(option.value)}
				disallowEmptySelection
				itemComponent={(itemProps) => (
					<MenuItem<typeof KSelect.Item>
						as={KSelect.Item}
						item={itemProps.item}
					>
						<KSelect.ItemLabel class="flex-1">
							{itemProps.item.rawValue.name}
						</KSelect.ItemLabel>
					</MenuItem>
				)}
			>
				<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
					<KSelect.Value<{
						name: string;
						value: CornerRoundingType;
					}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
						{(state) => <span>{state.selectedOption().name}</span>}
					</KSelect.Value>
					<KSelect.Icon<ValidComponent>
						as={(iconProps) => (
							<IconCapChevronDown
								{...iconProps}
								class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
							/>
						)}
					/>
				</KSelect.Trigger>
				<KSelect.Portal>
					<PopperContent<typeof KSelect.Content>
						as={KSelect.Content}
						class={cx(topSlideAnimateClasses, "z-50")}
					>
						<MenuItemList<typeof KSelect.Listbox>
							class="overflow-y-auto max-h-32"
							as={KSelect.Listbox}
						/>
					</PopperContent>
				</KSelect.Portal>
			</KSelect>
		</div>
	);
}
