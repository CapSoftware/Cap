import { For } from "solid-js";
import "./ink-loader.css";

const PERIOD = 12;
const WAVES = 4;
const MID = 8;

function inkSquigglePath(seed: number) {
	let state = seed * 7919 + 13;
	const random = () => {
		state = (state * 16807) % 2147483647;
		return state / 2147483647;
	};
	const halves = Array.from({ length: WAVES * 2 }, () => ({
		amplitude: 3.2 * (0.82 + random() * 0.36),
		dx: (random() - 0.5) * 1.4,
		dy: (random() - 0.5) * 0.9,
	}));
	let d = `M0 ${MID}`;
	for (let index = 0; index < WAVES * 4; index++) {
		const half = halves[index % halves.length];
		if (!half) continue;
		const start = (index * PERIOD) / 2;
		const sign = index % 2 ? 1 : -1;
		d += ` Q${(start + PERIOD / 4 + half.dx).toFixed(2)} ${(MID + sign * half.amplitude * 2 + half.dy).toFixed(2)} ${start + PERIOD / 2} ${MID}`;
	}
	return d;
}

const INK_PATHS = [1, 2, 3].map(inkSquigglePath);

export function InkLoader(props: {
	size?: "sm" | "md" | "lg";
	tone?: "muted" | "media";
}) {
	return (
		<span
			aria-hidden="true"
			class="ink-loader"
			data-size={props.size ?? "md"}
			data-tone={props.tone ?? "muted"}
		>
			<span class="ink-loader-wave">
				<For each={INK_PATHS}>
					{(d) => (
						<span class="ink-loader-boil">
							<svg viewBox={`0 0 ${PERIOD * WAVES * 2} 16`} aria-hidden="true">
								<path d={d} />
							</svg>
						</span>
					)}
				</For>
			</span>
		</span>
	);
}
