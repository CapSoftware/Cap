import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { cx } from "cva";
import { Suspense } from "solid-js";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCirclePlus from "~icons/cap/circle-plus";
import IconCapPresets from "~icons/cap/presets";
import {
	DropdownItem,
	EditorButton,
	MenuItemList,
	PopperContent,
	topCenterAnimateClasses,
} from "./ui";

export function PresetsDropdown() {
	return (
		<KDropdownMenu gutter={8} placement="bottom">
			<EditorButton<typeof KDropdownMenu.Trigger>
				as={KDropdownMenu.Trigger}
				leftIcon={<IconCapPresets />}
				rightIcon={<IconCapChevronDown />}
			>
				Presets
			</EditorButton>
			<KDropdownMenu.Portal>
				<Suspense>
					<PopperContent<typeof KDropdownMenu.Content>
						as={KDropdownMenu.Content}
						class={cx("w-72 max-h-56", topCenterAnimateClasses)}
					>
						<MenuItemList<typeof KDropdownMenu.Group>
							as={KDropdownMenu.Group}
							class="overflow-y-auto flex-1 scrollbar-none"
						>
							<div class="py-1 w-full text-sm text-center text-gray-11">
								No Presets
							</div>
						</MenuItemList>
						<MenuItemList<typeof KDropdownMenu.Group>
							as={KDropdownMenu.Group}
							class="border-t shrink-0"
						>
							<DropdownItem disabled>
								<span>Create new preset</span>
								<IconCapCirclePlus class="ml-auto" />
							</DropdownItem>
						</MenuItemList>
					</PopperContent>
				</Suspense>
			</KDropdownMenu.Portal>
		</KDropdownMenu>
	);
}

export default PresetsDropdown;
