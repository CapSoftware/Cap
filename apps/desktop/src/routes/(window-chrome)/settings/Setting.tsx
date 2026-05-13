import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Toggle } from "~/components/Toggle";

export function SettingItem(props: {
	pro?: boolean;
	label: string;
	description?: string;
	children: JSX.Element;
}) {
	return (
		<div class="flex flex-row gap-4 justify-between items-center px-4 py-3.5">
			<div class="flex flex-col flex-1 min-w-0 gap-0.5">
				<p class="text-[13px] text-gray-12">{props.label}</p>
				<Show when={props.description}>
					<p class="text-xs leading-snug text-gray-10">{props.description}</p>
				</Show>
			</div>
			<div class="flex shrink-0 items-center">{props.children}</div>
		</div>
	);
}

export function ToggleSettingItem(props: {
	pro?: boolean;
	label: string;
	description?: string;
	value: boolean;
	onChange(v: boolean): void;
}) {
	return (
		<SettingItem {...props}>
			<Toggle
				size="sm"
				checked={props.value}
				onChange={(v) => props.onChange(v)}
			/>
		</SettingItem>
	);
}
