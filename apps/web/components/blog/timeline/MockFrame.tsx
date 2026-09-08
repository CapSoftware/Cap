import { clamp, DEMO_DURATION } from "./scene";

/**
 * A drawn frame of the fictional recording, at a given second.
 *
 * The post needs a film that visibly changes across its length — a filmstrip of
 * six identical gradients teaches nothing — but shipping a real video to a blog
 * post is a lot of bytes for a texture. So the "recording" is an SVG of a small
 * app being demoed, driven entirely by time: charts fill in, a cursor crosses to
 * a button, a dialog opens (with the flickering logo two of the demo comments
 * complain about), then it closes on a success state.
 *
 * `slice` cropping means the same component works as a 160x90 preview or as a
 * narrow filmstrip tile.
 */

const ACT_2 = 0.25;
const ACT_3 = 0.41;
const ACT_4 = 0.72;

interface Waypoint {
	p: number;
	x: number;
	y: number;
}

/** Where the cursor is, so it travels continuously across the whole scene. */
const CURSOR_PATH: readonly Waypoint[] = [
	{ p: 0, x: 55, y: 72 },
	{ p: ACT_2, x: 78, y: 55 },
	{ p: ACT_3, x: 137, y: 20 },
	{ p: 0.5, x: 110, y: 42 },
	{ p: ACT_4, x: 96, y: 62 },
	{ p: 1, x: 122, y: 74 },
];

function cursorAt(p: number) {
	for (let i = 1; i < CURSOR_PATH.length; i++) {
		const from = CURSOR_PATH[i - 1];
		const to = CURSOR_PATH[i];
		if (!from || !to) break;
		if (p > to.p) continue;
		const span = to.p - from.p;
		const k = span <= 0 ? 1 : (p - from.p) / span;
		// Ease so it settles on each target rather than sliding at constant speed.
		const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
		return {
			x: from.x + (to.x - from.x) * eased,
			y: from.y + (to.y - from.y) * eased,
		};
	}
	const last = CURSOR_PATH[CURSOR_PATH.length - 1];
	return { x: last?.x ?? 0, y: last?.y ?? 0 };
}

/** 0 outside the range, ramping to 1 just inside each edge. */
const band = (p: number, start: number, end: number, ramp = 0.02) =>
	clamp(Math.min((p - start) / ramp, (end - p) / ramp), 0, 1);

const BAR_HEIGHTS = [22, 34, 27, 41];

export function MockFrame({
	time,
	className,
}: {
	time: number;
	className?: string;
}) {
	const p = clamp(time / DEMO_DURATION, 0, 1);
	const cursor = cursorAt(p);
	// Never fully empty: a filmstrip tile at t=0 should still look like an app.
	const grow = 0.4 + 0.6 * clamp(p / 0.2, 0, 1);
	const dialog = band(p, ACT_3, ACT_4, 0.015);
	const success = band(p, ACT_4 + 0.02, 1.2, 0.03);
	const buttonHot = band(p, ACT_3 - 0.05, ACT_3 + 0.01, 0.03);
	// The defect Sam and Priya are pointing at: while the dialog is up, the mark
	// in its corner drops out every other beat.
	const flicker = dialog > 0 && Math.sin(time * 7.5) > 0.35 ? 0.25 : 1;

	return (
		<svg
			viewBox="0 0 160 90"
			preserveAspectRatio="xMidYMid slice"
			className={className}
			aria-hidden
		>
			<title>A frame of the example recording</title>
			<rect width="160" height="90" fill="#ffffff" />

			{/* Window chrome */}
			<rect width="160" height="11" fill="#f3f5f9" />
			<circle cx="7" cy="5.5" r="1.6" fill="#e0e4ec" />
			<circle cx="12.5" cy="5.5" r="1.6" fill="#e0e4ec" />
			<circle cx="18" cy="5.5" r="1.6" fill="#e0e4ec" />
			<rect x="26" y="3" width="62" height="5" rx="2.5" fill="#e7eaf0" />

			{/* Sidebar */}
			<rect y="11" width="30" height="79" fill="#f7f8fb" />
			{[18, 26, 34, 42].map((y, index) => (
				<rect
					key={y}
					x="6"
					y={y}
					width={index === 0 ? 17 : 13 + index * 2}
					height="3"
					rx="1.5"
					fill={index === 1 ? "var(--blue-9, #4785ff)" : "#e1e5ee"}
					opacity={index === 1 ? 0.5 : 1}
				/>
			))}

			{/* Content header + the button the cursor is heading for */}
			<rect x="38" y="19" width="44" height="5" rx="2.5" fill="#dfe3ec" />
			<rect x="38" y="28" width="30" height="3" rx="1.5" fill="#eaedf3" />
			<rect
				x="124"
				y="18"
				width="28"
				height="9"
				rx="4.5"
				fill="var(--blue-9, #4785ff)"
				opacity={0.55 + 0.45 * buttonHot}
			/>

			{/* The chart being talked through */}
			{BAR_HEIGHTS.map((height, index) => {
				const appears = index === 3 ? success : 1;
				const h = height * grow * appears;
				return (
					<rect
						key={height}
						x={40 + index * 15}
						y={78 - h}
						width="10"
						height={Math.max(0, h)}
						rx="2"
						fill="var(--blue-9, #4785ff)"
						opacity={0.25 + index * 0.2}
					/>
				);
			})}
			<rect x="38" y="80" width="114" height="1.5" rx="0.75" fill="#e7eaf0" />

			{/* Success state after the dialog closes */}
			{success > 0 && (
				<g opacity={success}>
					<circle cx="139" cy="63" r="8" fill="#10b981" opacity="0.14" />
					<path
						d="M135 63.5l2.8 2.8 5.4-5.6"
						stroke="#10b981"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</g>
			)}

			{/* The dialog */}
			{dialog > 0 && (
				<g opacity={dialog}>
					<rect y="11" width="160" height="79" fill="#12161f" opacity="0.22" />
					<rect
						x="44"
						y="24"
						width="80"
						height="46"
						rx="5"
						fill="#ffffff"
						stroke="#e1e5ee"
					/>
					<rect
						x="50"
						y="30"
						width="8"
						height="8"
						rx="2.5"
						fill="var(--blue-9, #4785ff)"
						opacity={flicker}
					/>
					<rect x="62" y="32" width="30" height="4" rx="2" fill="#dfe3ec" />
					<rect x="50" y="44" width="60" height="3" rx="1.5" fill="#eaedf3" />
					<rect x="50" y="51" width="44" height="3" rx="1.5" fill="#eaedf3" />
					<rect
						x="88"
						y="58"
						width="30"
						height="8"
						rx="4"
						fill="var(--blue-9, #4785ff)"
					/>
				</g>
			)}

			{/* Cursor */}
			<g transform={`translate(${cursor.x.toFixed(2)} ${cursor.y.toFixed(2)})`}>
				<path
					d="M0 0l0 9.5 2.4-2.4 1.6 3.4 1.8-.9-1.6-3.3 3.3-.1z"
					fill="#12161f"
					stroke="#ffffff"
					strokeWidth="0.6"
					strokeLinejoin="round"
				/>
			</g>
		</svg>
	);
}
