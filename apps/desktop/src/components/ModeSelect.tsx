import { cx } from "cva";
import { type JSX, Show } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import type { RecordingMode } from "~/utils/tauri";

interface ModeOptionProps {
	mode: RecordingMode;
	title: string;
	description: string;
	standalone?: boolean;
	icon: (props: { class: string; style?: JSX.CSSProperties }) => JSX.Element;
	isSelected: boolean;
	onSelect: (mode: RecordingMode) => void;
}

const ModeOption = (props: ModeOptionProps) => {
	return (
		<div
			onClick={() => props.onSelect(props.mode)}
			class={cx(
				`p-5 space-y-3 rounded-lg border transition-all duration-200 border-gray-4 dark:border-gray-3 h-fit bg-gray-3 dark:bg-gray-2`,
			)}
		>
			<div class="flex flex-col items-center mb-2 text-center">
				{props.icon({
					class: "size-12 mb-5 invert dark:invert-0",
				})}
				<h3 class="text-lg font-medium text-gray-12">{props.title}</h3>
			</div>

			<p class={`mx-auto w-full text-sm text-gray-11 max-w-[300px]`}>
				{props.description}
			</p>
		</div>
	);
};

const ModeSelect = (props: { onClose?: () => void; standalone?: boolean }) => {
	const { rawOptions, setOptions } = createOptionsQuery();

	const handleModeChange = (mode: RecordingMode) => {
		setOptions({ mode });
	};

	const modeOptions = [
		{
			mode: "instant" as const,
			title: "Instant Mode",
			description:
				"Share your screen instantly with a magic link — no waiting for rendering, just capture and share in seconds.",
			icon: IconCapInstant,
		},
		{
			mode: "studio" as const,
			title: "Studio Mode",
			description:
				"Records at the highest quality/framerate. Captures both your screen and camera separately for editing later.",
			icon: IconCapFilmCut,
		},
	];

	return (
		<div
			class={cx(
				"grid grid-cols-2 gap-8 items-center text-center bg-gray-1",
				props.standalone
					? "absolute z-10 border border-gray-3 p-16 rounded-xl"
					: "",
			)}
			onClick={(e) => e.stopPropagation()}
		>
			<Show when={props.onClose}>
				<div
					onClick={() => props.onClose?.()}
					class="absolute -top-2.5 -right-2.5 p-2 rounded-full border duration-200 bg-gray-2 border-gray-3 hover:bg-gray-3 transition-duration"
				>
					<IconCapX class="invert-1 size-2 dark:invert" />
				</div>
			</Show>
			{props.standalone && (
				<h2 class="text-[24px] col-span-2 font-medium text-center text-gray-12">
					Recording Modes
				</h2>
			)}
			{modeOptions.map((option) => (
				<ModeOption
					mode={option.mode}
					title={option.title}
					description={option.description}
					icon={option.icon}
					isSelected={rawOptions.mode === option.mode}
					onSelect={handleModeChange}
				/>
			))}
		</div>
	);
};

export default ModeSelect;
