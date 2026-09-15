import { For, Show } from "solid-js";
import {
	type PreparingEditorModel,
	preparingTime,
} from "./preparing-editor-model";

const TRACK_NAMES = {
	display: "Screen",
	camera: "Camera",
	microphone: "Microphone",
	systemAudio: "System audio",
};

export function PreparingTimeline(props: { model: PreparingEditorModel }) {
	const timeline = () => props.model.timeline();
	const tracks = () => {
		const declared = props.model.seed().tracks;
		return declared?.length
			? declared.map((track) => TRACK_NAMES[track])
			: ["Recording"];
	};
	const position = () => {
		const total = timeline().totalDuration;
		return total === null
			? 0
			: Math.min(1, props.model.playback().playheadSeconds / total);
	};
	const status = () => {
		if (props.model.progress().phase === "unavailable") {
			return "Your recording will be available when preparation finishes";
		}
		if (props.model.progress().phase === "handoff")
			return "Opening your editor";
		if (props.model.playback().buffering) return "Preparing the next part";
		if (timeline().playableUntil > 0) {
			return `Playable to ${preparingTime(timeline().playableUntil)}`;
		}
		return "Preparing playback";
	};
	return (
		<div
			class="flex flex-col h-full rounded-xl bg-ed-card shadow-ed-card overflow-hidden px-3 pt-2.5 pb-3"
			aria-label="Recording timeline"
		>
			<div class="flex items-end h-[26px] shrink-0">
				<div class="w-[104px] pl-1 shrink-0 text-[11px] text-ed-text-3">
					Timeline
				</div>
				<div class="flex flex-1 justify-between gap-2 pb-1 text-[10px] tabular-nums text-ed-text-3">
					<Show
						when={timeline().totalDuration}
						fallback={<span>Recording duration is being checked</span>}
					>
						{(duration) => (
							<For each={[0, 0.25, 0.5, 0.75, 1]}>
								{(fraction) => (
									<span>{preparingTime(duration() * fraction)}</span>
								)}
							</For>
						)}
					</Show>
				</div>
			</div>
			<div class="flex flex-col gap-1.5 mt-1 overflow-y-auto min-h-0">
				<For each={tracks()}>
					{(track, index) => (
						<div class="flex items-center h-11 min-h-11 rounded-lg bg-ed-ctl">
							<div class="pl-2 w-[104px] shrink-0 text-[11px] text-ed-text-2 truncate">
								{track}
							</div>
							<div class="relative flex-1 h-full overflow-hidden rounded-r-lg">
								<div class="absolute inset-0 bg-ed-ctl-hover opacity-40" />
								<Show when={timeline().fraction !== null}>
									<div
										class="absolute inset-y-0 left-0 bg-ed-accent/25 border-r border-ed-accent/50"
										style={{ width: `${(timeline().fraction ?? 0) * 100}%` }}
									/>
									<div
										class="absolute inset-y-0 right-0 overflow-hidden"
										style={{ left: `${(timeline().fraction ?? 0) * 100}%` }}
									>
										<div class="absolute inset-0 bg-ed-card/40 backdrop-blur-[3px]" />
										<div class="absolute -left-2 inset-y-0 w-5 bg-ed-card/50 blur-md" />
									</div>
									<div
										class="absolute inset-y-0 w-px bg-ed-text-2 pointer-events-none"
										style={{ left: `${position() * 100}%` }}
									/>
								</Show>
								<Show when={index() === 0}>
									<span
										class="absolute inset-0 flex items-center justify-center text-[11px] text-ed-text-3 pointer-events-none"
										role="status"
									>
										{status()}
									</span>
								</Show>
								<input
									type="range"
									min="0"
									max={timeline().totalDuration ?? 0}
									step="0.001"
									value={props.model.playback().playheadSeconds}
									disabled={
										!props.model.canPlay() || timeline().totalDuration === null
									}
									aria-label={`Seek ${track.toLowerCase()}`}
									aria-valuetext={preparingTime(
										props.model.playback().playheadSeconds,
									)}
									class="absolute inset-0 w-full h-full opacity-0 enabled:cursor-pointer focus-visible:opacity-100"
									onChange={(event) =>
										void props.model.seek(event.currentTarget.valueAsNumber)
									}
								/>
							</div>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}
