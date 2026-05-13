import { HoverCard } from "@kobalte/core/hover-card";
import { cx } from "cva";
import { type JSX, Show } from "solid-js";

import { useRecordingOptions } from "~/routes/(window-chrome)/OptionsContext";
import { commands, events, type RecordingMode } from "~/utils/tauri";

interface ModeProps {
	onInfoClick?: () => void;
}

type ModeButtonConfig = {
	mode: RecordingMode;
	label: string;
	description: string;
	settingsSection: "instant-quality" | "studio-quality" | null;
	icon: (props: { class?: string }) => JSX.Element;
	iconClass: string;
};

const MODE_BUTTONS: ModeButtonConfig[] = [
	{
		mode: "instant",
		label: "Instant mode",
		description:
			"No rendering required — uploads on the fly so you can share the link the moment you stop.",
		settingsSection: "instant-quality",
		icon: (p) => <IconCapInstant {...p} />,
		iconClass: "size-4 invert dark:invert-0",
	},
	{
		mode: "studio",
		label: "Studio mode",
		description:
			"Records at the highest quality for local rendering later. Opens the Cap editor when you're done.",
		settingsSection: "studio-quality",
		icon: (p) => <IconCapFilmCut {...p} />,
		iconClass: "size-[0.9rem] invert dark:invert-0",
	},
	{
		mode: "screenshot",
		label: "Screenshot mode",
		description: "Capture and annotate stills.",
		settingsSection: null,
		icon: (p) => <IconCapScreenshot {...p} />,
		iconClass: "size-[0.9rem] invert dark:invert-0",
	},
];

const Mode = (props: ModeProps) => {
	const { rawOptions, setOptions } = useRecordingOptions();

	const handleInfoClick = () => {
		if (props.onInfoClick) {
			props.onInfoClick();
		} else {
			commands.showWindow("ModeSelect");
		}
	};

	const openQualitySettings = async (
		section: "instant-quality" | "studio-quality",
	) => {
		try {
			localStorage.setItem("cap.settings.scrollToSection", section);
		} catch {}
		await commands.showWindow({ Settings: { page: "general" } });
		await events.requestScrollToSettingsSection.emit({ section });
	};

	return (
		<div class="flex relative gap-2 items-center p-1.5 rounded-full border border-gray-5 bg-gray-3 w-fit">
			<button
				type="button"
				onClick={handleInfoClick}
				class="absolute -left-1.5 -top-2 p-1 rounded-full w-fit bg-gray-5 group focus:outline-none"
				aria-label="Recording mode info"
			>
				<IconCapInfo class="invert transition-opacity duration-200 cursor-pointer size-2.5 dark:invert-0 group-hover:opacity-50" />
			</button>

			{MODE_BUTTONS.map((button) => {
				const isSelected = () => rawOptions.mode === button.mode;

				return (
					<HoverCard
						openDelay={120}
						closeDelay={80}
						placement="bottom-end"
						gutter={12}
					>
						<HoverCard.Trigger
							as="div"
							onClick={() => {
								setOptions({ mode: button.mode });
								commands.setRecordingMode(button.mode);
							}}
							class={cx(
								"relative flex justify-center items-center rounded-full transition-all duration-200 cursor-pointer size-7",
								isSelected()
									? "ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-7 hover:bg-gray-7 ring-blue-500"
									: "bg-gray-3 hover:bg-gray-7",
							)}
						>
							<button.icon class={button.iconClass} />
						</HoverCard.Trigger>
						<HoverCard.Portal>
							<HoverCard.Content class="z-50 outline-none animate-in fade-in slide-in-from-top-1 duration-100">
								<div class="flex flex-col gap-2 px-3 py-2.5 rounded-lg border shadow-lg bg-gray-12 text-gray-1 border-gray-3 min-w-[12rem] max-w-[15rem]">
									<div class="flex flex-col gap-0.5">
										<span class="text-xs font-medium">{button.label}</span>
										<span class="text-[10px] text-gray-4 leading-snug">
											{button.description}
										</span>
									</div>
									<Show when={button.settingsSection}>
										{(section) => (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													void openQualitySettings(section());
												}}
												class="flex gap-1.5 items-center px-2 py-1 -mx-1 text-[11px] rounded-md transition-colors text-gray-4 hover:bg-gray-11 hover:text-gray-1"
											>
												<IconCapSettings class="size-3" />
												<span>Quality settings</span>
											</button>
										)}
									</Show>
								</div>
							</HoverCard.Content>
						</HoverCard.Portal>
					</HoverCard>
				);
			})}
		</div>
	);
};

export default Mode;
