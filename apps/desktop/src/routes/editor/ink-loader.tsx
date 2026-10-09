import { For } from "solid-js";
import "./ink-loader.css";

const PERIOD = 12;
const WAVES = 4;
const MID = 8;

/// A hand-drawn squiggle, two loops long so that sliding it one loop to the
/// left lands on the same shape. Each seed wobbles it a little differently.
/// The same mark as apps/web/components/ink-loader.tsx.
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

/// Cap's loading mark: a short line of ink that travels and boils like the
/// recorder's doodles. Only transforms and opacity animate, so it keeps
/// moving while the editor is busy.
export function InkLoader(props: {
	size?: "sm" | "md" | "lg";
	/** `media` draws in white over the preview's frame. */
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
