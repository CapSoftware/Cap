import { For } from "solid-js";
import {
	type Camera3DSegment,
	camera3DShotLabel,
	MAX_AUTO_CAMERA3D_SHOTS,
} from "./three-d";

export const camera3DShotSummary = (segment: Camera3DSegment) =>
	`3D shot · ${camera3DShotLabel(segment)} · ${(segment.end - segment.start).toFixed(1)}s`;

export function ShotCountPills(props: {
	max: number;
	current?: number | null;
	onHover: (count: number | null) => void;
	onPick: (count: number) => void;
}) {
	return (
		<div class="flex flex-row gap-1 items-center">
			<For
				each={Array.from({ length: MAX_AUTO_CAMERA3D_SHOTS }, (_, i) => i + 1)}
			>
				{(count) => (
					<button
						type="button"
						disabled={count > props.max}
						data-selected={props.current === count}
						title={
							count > props.max
								? "This recording is too short for that many shots"
								: `${count} ${count === 1 ? "shot" : "shots"}`
						}
						onMouseEnter={() => {
							if (count <= props.max) props.onHover(count);
						}}
						onMouseLeave={() => props.onHover(null)}
						onFocus={() => {
							if (count <= props.max) props.onHover(count);
						}}
						onBlur={() => props.onHover(null)}
						onClick={() => {
							if (count <= props.max) props.onPick(count);
						}}
						class="cap-shot-pill outline-hidden"
					>
						{count}
					</button>
				)}
			</For>
		</div>
	);
}
