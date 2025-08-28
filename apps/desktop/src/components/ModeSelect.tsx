import { cx } from "cva";
import type { JSX } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import type { RecordingMode } from "~/utils/tauri";

interface ModeOptionProps {
	mode: RecordingMode;
	title: string;
	description: string;
	icon: (props: { class: string; style: JSX.CSSProperties }) => JSX.Element;
	isSelected: boolean;
	onSelect: (mode: RecordingMode) => void;
}

const ModeOption = (props: ModeOptionProps) => {
	return (
		<div
			onClick={() => props.onSelect(props.mode)}
			class={cx(
				`p-4 space-y-3 rounded-lg bg-gray-2 transition-all duration-200`,
				{
					"ring-2 ring-offset-2 hover:bg-gray-2 cursor-default ring-blue-9 ring-offset-gray-100":
						props.isSelected,
					"ring-2 ring-transparent ring-offset-transparent hover:bg-gray-3 cursor-pointer":
						!props.isSelected,
				},
			)}
		>
			<div class="flex flex-col items-center mb-2 text-center">
				{props.icon({
					class: cx(
						"size-12 mb-3",
						props.isSelected ? "opacity-100" : "opacity-30",
					),
					style: {
						filter: props.isSelected
							? "drop-shadow(0 0 0.5rem rgba(255, 255, 255, 0.5))"
							: "none",
					},
				})}
				<h3 class="text-lg font-medium text-gray-12">{props.title}</h3>
			</div>

			<p class={`mx-auto w-full text-sm text-gray-11 max-w-[300px]`}>
				{props.description}
			</p>
		</div>
	);
};

const ModeSelect = () => {
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
		<div class="grid grid-cols-2 gap-8 text-center">
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
