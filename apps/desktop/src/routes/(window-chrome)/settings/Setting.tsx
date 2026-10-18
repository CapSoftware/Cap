import { cx } from "cva";
import type { JSX, ParentProps } from "solid-js";
import { Show } from "solid-js";
import { Toggle } from "~/components/Toggle";

export function SettingsPageContent(props: ParentProps<{ class?: string }>) {
	return (
		<div class={cx("px-6 py-6 space-y-7 max-w-[42rem]", props.class)}>
			{props.children}
		</div>
	);
}

export function Section(
	props: ParentProps<{
		title: string;
		description?: string | JSX.Element;
		right?: JSX.Element;
		pro?: boolean;
	}>,
) {
	return (
		<section class="space-y-2.5">
			<header class="flex justify-between items-end gap-3 px-1">
				<div class="flex flex-col gap-0.5 min-w-0">
					<div class="flex gap-2 items-center">
						<h3 class="text-sm font-semibold tracking-tight text-gray-12">
							{props.title}
						</h3>
						<Show when={props.pro}>
							<span class="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-blue-9 text-white">
								Pro
							</span>
						</Show>
					</div>
					<Show when={props.description}>
						<div class="text-xs leading-relaxed text-gray-10">
							{props.description}
						</div>
					</Show>
				</div>
				<Show when={props.right}>
					<div class="flex shrink-0 gap-2 items-center">{props.right}</div>
				</Show>
			</header>
			{props.children}
		</section>
	);
}

export function SectionCard(
	props: ParentProps<{ class?: string; padded?: boolean }>,
) {
	return (
		<div
			class={cx(
				"cap-settings-card overflow-hidden rounded-xl border border-gray-3 bg-gray-2",
				props.padded && "px-4 py-4",
				props.class,
			)}
		>
			{props.children}
		</div>
	);
}

export function SectionRows(props: ParentProps) {
	return (
		<SectionCard class="divide-y divide-gray-3">{props.children}</SectionCard>
	);
}

export function SettingItem(props: {
	id?: string;
	pro?: boolean;
	label: string;
	description?: string;
	children: JSX.Element;
}) {
	return (
		<div
			id={props.id}
			class="cap-setting-row flex flex-row gap-4 justify-between items-center px-4 py-3.5"
		>
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
