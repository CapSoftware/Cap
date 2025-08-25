import { Tooltip as KTooltip } from "@kobalte/core";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import type { ComponentProps, JSX } from "solid-js";

interface Props extends ComponentProps<typeof KTooltip.Root> {
	content: JSX.Element;
	childClass?: string;
	kbd?: string[];
}

type Os = "android" | "ios" | "linux" | "macos" | "windows";

const kbdSymbolModifier = (key: string, os: Os) => {
	const obj = {
		meta: os === "macos" ? "⌘" : "ctrl",
		shift: "⇧",
		alt: os === "macos" ? "⌥" : "⎇",
	};
	return obj[key as keyof typeof obj] || key;
};

export default function Tooltip(props: Props) {
	const os = ostype();
	return (
		<KTooltip.Root {...props} openDelay={props.openDelay ?? 200}>
			<KTooltip.Trigger class={cx(props.childClass)}>
				{props.children}
			</KTooltip.Trigger>
			<KTooltip.Portal>
				<KTooltip.Content class="z-50 px-1.5 flex items-center py-1 text-xs border border-gray-3 bg-gray-12 text-gray-1 rounded-md shadow-lg duration-100 animate-in fade-in slide-in-from-top-1 min-w-6 gap-1.5 text-center">
					<span>{props.content}</span>
					{props.kbd && props.kbd.length > 0 && (
						<div class="space-x-1">
							{props.kbd?.map((kbd) => (
								<kbd class="py-0.5 px-[5px] text-[10px] rounded-md text-gray-12 bg-gray-1">
									{kbdSymbolModifier(kbd, os)}
								</kbd>
							))}
						</div>
					)}
					<KTooltip.Arrow size={16} />
				</KTooltip.Content>
			</KTooltip.Portal>
		</KTooltip.Root>
	);
}
