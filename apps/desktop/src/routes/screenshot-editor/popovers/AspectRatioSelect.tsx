import { Select as KSelect } from "@kobalte/core/select";
import { createSignal, Show } from "solid-js";
import type { AspectRatio } from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapLayout from "~icons/cap/layout";
import IconLucideCheckCircle from "~icons/lucide/check-circle-2";
import { ASPECT_RATIOS } from "../../editor/projectConfig";
import { useScreenshotEditorContext } from "../context";
import {
	EditorButton,
	MenuItem,
	MenuItemList,
	PopperContent,
	topLeftAnimateClasses,
} from "../ui";

export function AspectRatioSelect() {
	const { project, setProject } = useScreenshotEditorContext();
	const [open, setOpen] = createSignal(false);
	let triggerSelect: HTMLDivElement | undefined;

	return (
		<KSelect<AspectRatio | "auto">
			open={open()}
			onOpenChange={setOpen}
			ref={triggerSelect}
			value={project.aspectRatio ?? "auto"}
			onChange={(v) => {
				if (v === null) return;
				setProject("aspectRatio", v === "auto" ? null : v);
			}}
			defaultValue="auto"
			options={
				["auto", "wide", "vertical", "square", "classic", "tall"] as const
			}
			multiple={false}
			itemComponent={(props) => {
				const item = () =>
					props.item.rawValue === "auto"
						? null
						: ASPECT_RATIOS[props.item.rawValue];

				return (
					<MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
						<KSelect.ItemLabel class="flex-1">
							{props.item.rawValue === "auto"
								? "Auto"
								: ASPECT_RATIOS[props.item.rawValue].name}
							<Show when={item()}>
								{(item) => (
									<span class="text-gray-11">
										{"⋅"}
										{item().ratio[0]}:{item().ratio[1]}
									</span>
								)}
							</Show>
						</KSelect.ItemLabel>
						<KSelect.ItemIndicator class="ml-auto">
							<IconLucideCheckCircle />
						</KSelect.ItemIndicator>
					</MenuItem>
				);
			}}
			placement="bottom-start"
		>
			<EditorButton<typeof KSelect.Trigger>
				as={KSelect.Trigger}
				class="w-20"
				tooltipText="Aspect Ratio"
				leftIcon={<IconCapLayout class="size-4" />}
				rightIcon={
					<KSelect.Icon>
						<IconCapChevronDown class="size-4" />
					</KSelect.Icon>
				}
				rightIconEnd={true}
			>
				<KSelect.Value<AspectRatio | "auto">>
					{(state) => {
						const text = () => {
							const option = state.selectedOption();
							if (option === "auto") return "Auto";
							const ratio = ASPECT_RATIOS[option].ratio;
							return `${ratio[0]}:${ratio[1]}`;
						};
						return <>{text()}</>;
					}}
				</KSelect.Value>
			</EditorButton>
			<KSelect.Portal>
				<PopperContent<typeof KSelect.Content>
					as={KSelect.Content}
					class={topLeftAnimateClasses}
				>
					<MenuItemList<typeof KSelect.Listbox>
						as={KSelect.Listbox}
						class="w-[12.5rem]"
					/>
				</PopperContent>
			</KSelect.Portal>
		</KSelect>
	);
}
