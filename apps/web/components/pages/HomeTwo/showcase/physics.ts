/**
 * The desktop editor's motion, ported so the landing demos move the way an
 * exported Cap does. Constants mirror the Rust defaults:
 *
 * - ZOOM_SPRING: `ScreenMovementSpring::default()` (crates/project), which
 *   drives both the zoom amount and the zoom centre
 *   (crates/rendering/src/zoom_spring.rs).
 * - CURSOR_SPRING: the default "Mellow" cursor smoothing preset.
 * - CLICK: `CLICK_SHRINK_SIZE` / `CURSOR_CLICK_DURATION` in
 *   crates/rendering/src/layers/cursor.rs.
 * - AUTO_ZOOM: the click padding in `generate_zoom_segments_from_clicks`,
 *   the 1.5x default zoom amount, and `ZoomSegment::default_edge_snap_ratio`.
 */

export type SpringConfig = { tension: number; mass: number; friction: number };

export const ZOOM_SPRING: SpringConfig = {
	tension: 200,
	mass: 2.25,
	friction: 40,
};

export const CURSOR_SPRING: SpringConfig = {
	tension: 470,
	mass: 3,
	friction: 70,
};

export const CLICK = { shrink: 0.8, ms: 130 } as const;

export const AUTO_ZOOM = {
	amount: 1.5,
	preMs: 300,
	postMs: 2500,
	edgeSnap: 0.25,
} as const;

/** `SegmentBounds::snap_to_edges`: focus near an edge sticks to it. */
export const snapToEdges = (scalar: number, ratio = AUTO_ZOOM.edgeSnap) => {
	if (ratio <= 0) return scalar;
	const lo = ratio;
	const hi = 1 - ratio + 0.0001;
	if (hi <= lo) return 0.5;
	return Math.min(1, Math.max(0, (scalar - lo) / (hi - lo)));
};

/**
 * Runs a spring-mass-damper toward a moving target and samples it on a fixed
 * grid, like the editor's precomputed zoom timeline. Integration uses 1 ms
 * semi-implicit Euler steps; the springs here are near critical damping, so
 * that matches the editor's closed-form solution to well under a pixel.
 */
export const simulate = (
	target: (ms: number) => number[],
	durationMs: number,
	spring: SpringConfig,
	sampleMs = 4,
): number[][] => {
	const start = target(0);
	const position = [...start];
	const velocity = start.map(() => 0);
	const samples: number[][] = [[...position]];
	const dt = 0.001;
	for (let ms = 1; ms <= durationMs; ms++) {
		const goal = target(ms);
		for (let i = 0; i < position.length; i++) {
			const p = position[i] ?? 0;
			const v = velocity[i] ?? 0;
			const force =
				-spring.tension * (p - (goal[i] ?? 0)) - spring.friction * v;
			const next = v + (force / spring.mass) * dt;
			velocity[i] = next;
			position[i] = p + next * dt;
		}
		if (ms % sampleMs === 0) samples.push([...position]);
	}
	return samples;
};

export const sampleAt = (samples: number[][], ms: number, sampleMs = 4) => {
	const f = Math.max(0, ms / sampleMs);
	const i = Math.min(samples.length - 1, Math.floor(f));
	const j = Math.min(samples.length - 1, i + 1);
	const k = f - i;
	const a = samples[i] ?? [];
	const b = samples[j] ?? a;
	return a.map((v, n) => v + ((b[n] ?? v) - v) * k);
};

export const minJerk = (s: number) => {
	const x = Math.min(1, Math.max(0, s));
	return x * x * x * (10 - 15 * x + 6 * x * x);
};

export type Waypoint = { at: number; x: number; y: number; hold?: number };

export const rawPath = (points: Waypoint[]) => (ms: number) => {
	const first = points[0];
	if (!first) return [0, 0];
	let prev = first;
	for (const point of points) {
		if (ms < point.at) {
			const from = prev.at + (prev.hold ?? 0);
			const k = minJerk((ms - from) / Math.max(1, point.at - from));
			return [prev.x + (point.x - prev.x) * k, prev.y + (point.y - prev.y) * k];
		}
		prev = point;
	}
	return [prev.x, prev.y];
};

export const clickShrink = (ms: number, downAt: number) => {
	const t = ms - downAt;
	if (t < -CLICK.ms || t > CLICK.ms * 2) return 1;
	const k =
		t < 0 ? 1 + t / CLICK.ms : t < CLICK.ms ? 0 : (t - CLICK.ms) / CLICK.ms;
	const eased = Math.min(1, Math.max(0, k));
	return CLICK.shrink + (1 - CLICK.shrink) * eased;
};
