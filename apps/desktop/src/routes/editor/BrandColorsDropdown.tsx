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
						"flex h-8 w-full items-center gap-2 rounded-[7px] bg-ed-ctl px-2 text-[13px] text-ed-text-1 outline-hidden transition-colors duration-150 hover:bg-ed-ctl-hover data-expanded:bg-ed-ctl-hover disabled:pointer-events-none disabled:opacity-50",
						props.class,
					)}
				>
					<span class="min-w-0 flex-1 truncate text-left">Brand colours</span>
					<span class="flex shrink-0 -space-x-1">
						<For each={props.swatches.slice(0, 4)}>
							{(swatch) => (
								<span
									class="size-4 rounded-full border border-ed-card"
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
					<IconCapChevronDown class="size-3.5 shrink-0 text-ed-text-3" />
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
										<span class="text-[11px] text-ed-text-3 tabular-nums">
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
