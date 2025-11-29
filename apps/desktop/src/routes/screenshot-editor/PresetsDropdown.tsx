import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { cx } from "cva";
import { Suspense } from "solid-js";
import IconCapCirclePlus from "~icons/cap/circle-plus";
import IconCapPresets from "~icons/cap/presets";
import IconLucideChevronRight from "~icons/lucide/chevron-right";
import {
	DropdownItem,
	MenuItemList,
	PopperContent,
	topSlideAnimateClasses,
} from "./ui";

export function PresetsSubMenu() {
	return (
		<KDropdownMenu.Sub gutter={8}>
			<KDropdownMenu.SubTrigger
				as={DropdownItem}
				class="justify-between cursor-default"
			>
				<div class="flex items-center gap-2">
					<IconCapPresets />
					<span>Presets</span>
				</div>
				<IconLucideChevronRight class="size-3 text-gray-10" />
			</KDropdownMenu.SubTrigger>
			<KDropdownMenu.Portal>
				<Suspense>
					<PopperContent<typeof KDropdownMenu.SubContent>
						as={KDropdownMenu.SubContent}
						class={cx("w-72 max-h-56", topSlideAnimateClasses)}
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
		</KDropdownMenu.Sub>
	);
}

export default PresetsSubMenu;
