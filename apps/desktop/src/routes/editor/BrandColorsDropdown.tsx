import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { cx } from "cva";
import { For, Show } from "solid-js";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import IconCapChevronDown from "~icons/cap/chevron-down";
import { getColorPreviewBorderColor } from "./color-utils";
import { DropdownItem, PopperContent, topLeftAnimateClasses } from "./ui";

export function BrandColorsDropdown(props: {
	swatches: OrganizationBrandColorSwatch[];
	onSelect: (color: string) => void;
	disabled?: boolean;
	class?: string;
}) {
	return (
		<Show when={props.swatches.length > 0}>
			<KDropdownMenu gutter={6} placement="bottom-start">
				<KDropdownMenu.Trigger
					disabled={props.disabled}
					class={cx(
						"flex h-8 w-full items-center gap-2 rounded-lg border border-gray-3 bg-gray-2 px-2 text-sm text-gray-12 transition-colors hover:border-gray-4 hover:bg-gray-3 disabled:pointer-events-none disabled:opacity-50",
						props.class,
					)}
				>
					<span class="min-w-0 flex-1 truncate text-left">Brand colours</span>
					<span class="flex shrink-0 -space-x-1">
						<For each={props.swatches.slice(0, 4)}>
							{(swatch) => (
								<span
									class="size-4 rounded-full border border-gray-1"
									style={{
										"background-color": swatch.color,
										"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(
											swatch.color,
										)}`,
									}}
								/>
							)}
						</For>
					</span>
					<IconCapChevronDown class="size-4 shrink-0 text-gray-10" />
				</KDropdownMenu.Trigger>
				<KDropdownMenu.Portal>
					<PopperContent<typeof KDropdownMenu.Content>
						as={KDropdownMenu.Content}
						class={cx("w-56", topLeftAnimateClasses)}
					>
						<div class="p-1.5">
							<For each={props.swatches}>
								{(swatch) => (
									<DropdownItem
										class="h-9 gap-2"
										onSelect={() => props.onSelect(swatch.color)}
									>
										<span
											class="size-5 shrink-0 rounded-md"
											style={{
												"background-color": swatch.color,
												"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(
													swatch.color,
												)}`,
											}}
										/>
										<span class="min-w-0 flex-1 truncate">{swatch.label}</span>
										<span class="text-xs text-gray-10 tabular-nums">
											{swatch.color}
										</span>
									</DropdownItem>
								)}
							</For>
						</div>
					</PopperContent>
				</KDropdownMenu.Portal>
			</KDropdownMenu>
		</Show>
	);
}
