import { Combobox as KCombobox } from "@kobalte/core/combobox";
import { cx } from "cva";
import { createMemo, createResource } from "solid-js";
import {
	cssFontFamily,
	fontFamilyLabel,
	GENERIC_FONT_OPTIONS,
	listSystemFonts,
} from "~/utils/fonts";
import {
	MenuItem,
	MenuItemList,
	PopperContent,
	topSlideAnimateClasses,
} from "./ui";

type FontOption = { value: string; label: string };

export function FontPicker(props: {
	value: string;
	onChange: (family: string) => void;
}) {
	const [installedFonts] = createResource(listSystemFonts);

	const options = createMemo<FontOption[]>(() => [
		...GENERIC_FONT_OPTIONS,
		...(installedFonts() ?? []).map((name) => ({ value: name, label: name })),
	]);

	const selected = createMemo<FontOption>(
		() =>
			options().find((option) => option.value === props.value) ?? {
				value: props.value,
				label: fontFamilyLabel(props.value),
			},
	);

	return (
		<KCombobox<FontOption>
			options={options()}
			optionValue="value"
			optionTextValue="label"
			optionLabel="label"
			value={selected()}
			onChange={(option) => {
				if (option) props.onChange(option.value);
			}}
			defaultFilter="contains"
			placeholder="Search fonts…"
			itemComponent={(itemProps) => (
				<MenuItem<typeof KCombobox.Item>
					as={KCombobox.Item}
					item={itemProps.item}
				>
					<KCombobox.ItemLabel
						class="flex-1 truncate"
						style={{
							"font-family": cssFontFamily(itemProps.item.rawValue.value),
						}}
					>
						{itemProps.item.rawValue.label}
					</KCombobox.ItemLabel>
					<KCombobox.ItemIndicator class="ml-auto text-ed-accent">
						<IconCapCircleCheck />
					</KCombobox.ItemIndicator>
				</MenuItem>
			)}
		>
			<KCombobox.Control class="flex h-[30px] w-full items-center justify-between rounded-[7px] border-0 bg-ed-ctl px-2.5 text-[12px] text-ed-text-1 transition-colors duration-150 hover:bg-ed-ctl-hover focus-within:bg-ed-ctl-hover focus-within:ring-1 focus-within:ring-ed-accent">
				<KCombobox.Input
					class="flex-1 min-w-0 bg-transparent outline-hidden text-ed-text-1 placeholder:text-ed-text-3"
					style={{ "font-family": cssFontFamily(props.value) }}
				/>
				<KCombobox.Trigger class="shrink-0 ml-2 text-ed-text-3">
					<KCombobox.Icon>
						<IconCapChevronDown class="size-3.5 transform transition-transform data-expanded:rotate-180" />
					</KCombobox.Icon>
				</KCombobox.Trigger>
			</KCombobox.Control>
			<KCombobox.Portal>
				<PopperContent<typeof KCombobox.Content>
					as={KCombobox.Content}
					class={cx(
						topSlideAnimateClasses,
						"z-50 w-(--kb-popper-anchor-width)",
					)}
				>
					<MenuItemList<typeof KCombobox.Listbox>
						class="overflow-y-auto max-h-64"
						as={KCombobox.Listbox}
					/>
				</PopperContent>
			</KCombobox.Portal>
		</KCombobox>
	);
}
