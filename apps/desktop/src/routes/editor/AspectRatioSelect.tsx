import { Select as KSelect } from "@kobalte/core/select";
import { createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import type { AspectRatio } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { ASPECT_RATIOS } from "./projectConfig";
import {
	EditorButton,
	MenuItem,
	MenuItemList,
	PopperContent,
	topLeftAnimateClasses,
} from "./ui";

function AspectRatioSelect() {
	const { project, setProject } = useEditorContext();
	const [open, setOpen] = createSignal(false);
	let triggerSelect: HTMLDivElement | undefined;

	return (
		<Tooltip content="Aspect Ratio">
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
								<IconCapCircleCheck />
							</KSelect.ItemIndicator>
						</MenuItem>
					);
				}}
				placement="top-start"
			>
				<EditorButton<typeof KSelect.Trigger>
					as={KSelect.Trigger}
					class="w-28"
					leftIcon={<IconCapLayout />}
					rightIcon={
						<KSelect.Icon>
							<IconCapChevronDown />
						</KSelect.Icon>
					}
					rightIconEnd={true}
				>
					<KSelect.Value<AspectRatio | "auto">>
						{(state) => {
							const text = () => {
								const option = state.selectedOption();
								return option === "auto" ? "Auto" : ASPECT_RATIOS[option].name;
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
							class="w-50"
						/>
					</PopperContent>
				</KSelect.Portal>
			</KSelect>
		</Tooltip>
	);
}

export default AspectRatioSelect;
