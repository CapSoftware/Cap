import { Toggle } from "~/components/Toggle";

export function SettingItem(props: {
	pro?: boolean;
	label: string;
	description?: string;
	children: any;
}) {
	return (
		<div class="flex flex-row gap-2 justify-between items-center py-3 text-sm">
			<div class="flex flex-col justify-between items-start space-y-1">
				<div class="flex gap-2 items-center">
					<p class="text-white">{props.label}</p>
				</div>
				{props.description && (
					<p class="text-xs text-gray-11">{props.description}</p>
				)}
			</div>
			{props.children}
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
