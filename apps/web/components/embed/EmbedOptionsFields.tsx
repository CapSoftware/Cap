"use client";

import { Switch } from "@cap/ui";
import { useId } from "react";
import type { EmbedOptions } from "@/lib/embed-options";

export type EmbedToggleOptions = Pick<
	EmbedOptions,
	"showTitle" | "showOwner" | "showBranding" | "autoplay"
>;

export const DEFAULT_EMBED_TOGGLES: EmbedToggleOptions = {
	showTitle: true,
	showOwner: true,
	showBranding: true,
	autoplay: false,
};

/**
 * Autoplay only works muted in browsers, so the toggle sets both.
 */
export const embedTogglesToOptions = (
	toggles: EmbedToggleOptions,
): Partial<Omit<EmbedOptions, "startTime">> => ({
	...toggles,
	muted: toggles.autoplay,
});

const ROWS: {
	key: keyof EmbedToggleOptions;
	label: string;
	description?: string;
	pro?: boolean;
}[] = [
	{ key: "showTitle", label: "Title" },
	{ key: "showOwner", label: "Owner" },
	{ key: "showBranding", label: "Logo", pro: true },
	{
		key: "autoplay",
		label: "Autoplay",
		description: "Starts muted, as browsers require",
	},
];

export function EmbedOptionsFields({
	value,
	onChange,
	canHideBranding,
}: {
	value: EmbedToggleOptions;
	onChange: (value: EmbedToggleOptions) => void;
	canHideBranding: boolean;
}) {
	const id = useId();
	return (
		<fieldset className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
			<legend className="sr-only">Embed options</legend>
			{ROWS.map((row) => {
				const locked = row.pro === true && !canHideBranding;
				const inputId = `${id}-${row.key}`;
				return (
					<div key={row.key} className="flex items-center gap-3">
						<Switch
							id={inputId}
							checked={locked ? true : value[row.key]}
							disabled={locked}
							onCheckedChange={(checked) =>
								onChange({ ...value, [row.key]: checked })
							}
						/>
						<label
							htmlFor={inputId}
							className="flex min-w-0 flex-col text-[13px] leading-tight"
						>
							<span className="flex items-center gap-1.5 font-medium text-gray-12">
								{row.label}
								{locked && (
									<span className="inline-flex h-[18px] items-center rounded-full bg-blue-9 px-1.5 text-[10px] font-semibold leading-none text-white">
										Pro
									</span>
								)}
							</span>
							{row.description && (
								<span className="text-xs text-gray-10">{row.description}</span>
							)}
						</label>
					</div>
				);
			})}
		</fieldset>
	);
}
