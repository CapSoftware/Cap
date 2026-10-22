"use client";

import clsx from "clsx";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { useReducedMotion } from "motion/react";
import Image from "next/image";
import {
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * The cursor is drawn the way Cap's editor renders a recorded cursor
 * (crates/rendering: cursor_interpolation.rs, layers/cursor.rs and
 * shaders/cursor.wgsl), with the editor's defaults.
 */
type Spring = { tension: number; mass: number; friction: number };
/** "Mellow", the default cursor smoothing. */
const MELLOW: Spring = { tension: 470, mass: 3, friction: 70 };
/** Used while the primary button is held. */
const DRAG: Spring = { tension: 1000, mass: 1, friction: 40 };

/** 60px per 1080px of recording, which on the Mac these windows were
 * captured on comes to this fraction of the window's width. */
const CURSOR_HEIGHT_PER_WINDOW_WIDTH = 0.165;
const CLICK_DURATION = 0.13;
const CLICK_SHRINK = 0.8;
const TILT_LOOKBACK = 0.4;
const ROTATION_AMOUNT = 0.15;
const RESOLUTION_BASE = 1920;
const MAX_TILT_DEG = 20;
const MOTION_BLUR = 1;
const BLUR_TAPS = 21;
/** 480px of a 1920px frame. */
const MAX_SMEAR = 0.25;

/** Where the arrow's tip sits inside each cursor's viewBox. */
const CURSOR = {
	macos: {
		src: "/blog/gpui/cursor-macos.svg",
		width: 17,
		height: 24,
		tipX: 3.6,
		tipY: 3.2,
	},
	windows: {
		src: "/blog/gpui/cursor-windows.svg",
		width: 18,
		height: 25,
		tipX: 3.3,
		tipY: 3.75,
	},
} as const;

const SIDES = [
	{
		key: "before",
		version: "0.6.0",
		stack: "Tauri",
		window: "/blog/gpui/main-window-060-glass.png",
		height: 790,
	},
	{
		key: "after",
		version: "0.6.1",
		stack: "GPUI",
		window: "/blog/gpui/main-window-061-glass.png",
		height: 872,
	},
] as const;

const WINDOW_WIDTH = 660;

/** Closed-form step of a damped spring, as in spring_mass_damper.rs. Both
 * profiles above are underdamped, so that's the only case needed. */
function springStep(
	spring: Spring,
	displacement: number,
	velocity: number,
	t: number,
) {
	const omega0 = Math.sqrt(spring.tension / spring.mass);
	const zeta = spring.friction / (2 * Math.sqrt(spring.tension * spring.mass));
	const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
	const decay = Math.exp(-zeta * omega0 * t);
	const cos = Math.cos(omegaD * t);
	const sin = Math.sin(omegaD * t);
	const a = displacement;
	const b = (velocity + a * zeta * omega0) / omegaD;
	return [
		decay * (a * cos + b * sin),
		decay *
			((b * omegaD - a * zeta * omega0) * cos -
				(a * omegaD + b * zeta * omega0) * sin),
	] as const;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export function BeforeAfter() {
	const stageRef = useRef<HTMLDivElement>(null);
	const afterRef = useRef<HTMLDivElement>(null);
	const dividerRef = useRef<HTMLDivElement>(null);
	const windowRef = useRef<HTMLImageElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const spriteRef = useRef<HTMLCanvasElement | null>(null);
	const kickRef = useRef<() => void>(() => {});
	const sim = useRef({
		target: { x: 0.5, y: 0.5 },
		pos: { x: 0.5, y: 0.5 },
		vel: { x: 0, y: 0 },
		pressed: false,
		click: 0,
		history: [] as { t: number; x: number }[],
	});

	const reduceMotion = useReducedMotion() ?? false;
	const reduceRef = useRef(reduceMotion);
	reduceRef.current = reduceMotion;
	const { platform } = useDetectPlatform();
	const cursor = CURSOR[platform === "windows" ? "windows" : "macos"];
	const cursorRef = useRef(cursor);
	cursorRef.current = cursor;

	const [hovering, setHovering] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const image = new window.Image();
		image.src = cursor.src;
		image
			.decode()
			.then(() => {
				if (cancelled) return;
				const sprite = document.createElement("canvas");
				sprite.height = 256;
				sprite.width = Math.round((256 * cursor.width) / cursor.height);
				sprite
					.getContext("2d")
					?.drawImage(image, 0, 0, sprite.width, sprite.height);
				spriteRef.current = sprite;
				kickRef.current();
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cursor]);

	useEffect(() => {
		const stage = stageRef.current;
		const after = afterRef.current;
		const divider = dividerRef.current;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!stage || !after || !divider || !canvas || !ctx) return;

		const s = sim.current;
		let width = 0;
		let height = 0;
		let windowWidth = 0;
		let dpr = 1;
		let tilt = 0;
		let raf = 0;
		let last = 0;

		const draw = () => {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			const sprite = spriteRef.current;
			if (!sprite || reduceRef.current) return;
			const { width: vw, height: vh, tipX, tipY } = cursorRef.current;

			const scale = 1 - (1 - CLICK_SHRINK) * smoothstep(s.click);
			const h = windowWidth * CURSOR_HEIGHT_PER_WINDOW_WIDTH * scale;
			const w = (h * vw) / vh;
			const x = s.pos.x * width - (tipX / vw) * w;
			const y = s.pos.y * height - (tipY / vh) * h;

			// The smear is one frame's travel at 60fps, trailing the motion.
			let mx = (s.vel.x * width * MOTION_BLUR) / 60;
			let my = (s.vel.y * height * MOTION_BLUR) / 60;
			const length = Math.hypot(mx, my);
			if (length > MAX_SMEAR * width) {
				mx *= (MAX_SMEAR * width) / length;
				my *= (MAX_SMEAR * width) / length;
			}
			const taps = length < 0.5 ? 1 : BLUR_TAPS;

			// Adding up equal-weight copies gives the shader's box filter.
			ctx.globalCompositeOperation = taps > 1 ? "lighter" : "source-over";
			ctx.globalAlpha = 1 / taps;
			ctx.imageSmoothingQuality = "high";
			for (let i = 0; i < taps; i++) {
				const f = taps > 1 ? i / (taps - 1) : 0;
				ctx.setTransform(
					dpr,
					0,
					0,
					dpr,
					(x - mx * f) * dpr,
					(y - my * f) * dpr,
				);
				// The shader tilts around the sprite's top-left corner.
				ctx.rotate((-tilt * Math.PI) / 180);
				ctx.drawImage(sprite, 0, 0, w, h);
			}
		};

		const frame = (now: number) => {
			raf = 0;
			const t = now / 1000;
			const dt = Math.min(0.1, Math.max(0, t - last));
			last = t;

			let settled = true;
			for (const axis of ["x", "y"] as const) {
				if (reduceRef.current) {
					s.pos[axis] = s.target[axis];
					s.vel[axis] = 0;
					continue;
				}
				const [d, v] = springStep(
					s.pressed ? DRAG : MELLOW,
					s.pos[axis] - s.target[axis],
					s.vel[axis],
					dt,
				);
				s.pos[axis] = s.target[axis] + d;
				s.vel[axis] = v;
				if (Math.abs(d) > 1e-5 || Math.abs(v) > 1e-4) settled = false;
			}

			s.click = Math.min(
				1,
				Math.max(0, s.click + ((s.pressed ? 1 : -1) * dt) / CLICK_DURATION),
			);
			if (s.click !== (s.pressed ? 1 : 0)) settled = false;

			// Tilt follows how far the cursor moved sideways in the last 0.4s.
			const history = s.history;
			history.push({ t, x: s.pos.x });
			while (history.length > 2 && (history[1]?.t ?? t) <= t - TILT_LOOKBACK)
				history.shift();
			const [a = { t, x: s.pos.x }, b] = history;
			const past =
				b && b.t > a.t && a.t < t - TILT_LOOKBACK
					? a.x + ((b.x - a.x) * (t - TILT_LOOKBACK - a.t)) / (b.t - a.t)
					: a.x;
			tilt = Math.min(
				MAX_TILT_DEG,
				Math.max(
					-MAX_TILT_DEG,
					(s.pos.x - past) * RESOLUTION_BASE * 0.03 * ROTATION_AMOUNT,
				),
			);
			if (Math.abs(tilt) > 0.01) settled = false;

			const split = `${s.pos.x * 100}%`;
			after.style.clipPath = `inset(0 0 0 ${split})`;
			divider.style.left = split;
			stage.setAttribute("aria-valuenow", String(Math.round(s.target.x * 100)));
			draw();

			if (!settled) raf = requestAnimationFrame(frame);
		};

		kickRef.current = () => {
			if (raf) return;
			last = performance.now() / 1000;
			s.history.push({ t: last, x: s.pos.x });
			raf = requestAnimationFrame(frame);
		};

		const measure = () => {
			const rect = stage.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			dpr = window.devicePixelRatio || 1;
			windowWidth = windowRef.current?.offsetWidth || width * 0.31;
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			draw();
		};
		const observer = new ResizeObserver(measure);
		observer.observe(stage);
		measure();

		return () => {
			observer.disconnect();
			cancelAnimationFrame(raf);
			kickRef.current = () => {};
		};
	}, []);

	const point = (event: PointerEvent<HTMLDivElement>) => {
		const rect = stageRef.current?.getBoundingClientRect();
		if (!rect) return null;
		return {
			x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
		};
	};

	const move = (event: PointerEvent<HTMLDivElement>) => {
		const next = point(event);
		if (!next) return;
		sim.current.target = next;
		kickRef.current();
	};

	const release = () => {
		sim.current.pressed = false;
		kickRef.current();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 0.2 : 0.05;
		const target = sim.current.target;
		if (event.key === "ArrowLeft") target.x = Math.max(0, target.x - step);
		else if (event.key === "ArrowRight")
			target.x = Math.min(1, target.x + step);
		else return;
		event.preventDefault();
		kickRef.current();
	};

	const showCursor = hovering && !reduceMotion;

	return (
		<figure className="not-prose relative left-1/2 my-14 w-[min(94vw,68rem)] -translate-x-1/2 sm:my-20">
			<div
				ref={stageRef}
				role="slider"
				tabIndex={0}
				aria-label="Compare Cap 0.6.0 and Cap 0.6.1"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={50}
				aria-valuetext="Left shows 0.6.0 on Tauri, right shows 0.6.1 on GPUI"
				onKeyDown={onKeyDown}
				onPointerEnter={(event) => {
					if (event.pointerType !== "mouse") return;
					// Arrive from the split line at the pointer's height.
					const next = point(event);
					if (next) {
						sim.current.pos.y = next.y;
						sim.current.vel.y = 0;
					}
					setHovering(true);
					move(event);
				}}
				onPointerMove={(event) => {
					if (event.pointerType === "mouse" || event.buttons > 0) move(event);
				}}
				onPointerDown={(event) => {
					sim.current.pressed = true;
					move(event);
				}}
				onPointerUp={release}
				onPointerCancel={release}
				onPointerLeave={(event) => {
					release();
					if (event.pointerType === "mouse") setHovering(false);
				}}
				className={clsx(
					"relative aspect-[4/3] w-full touch-pan-y select-none overflow-hidden rounded-[20px] bg-[#E6E8EC] sm:rounded-[24px] outline-none ring-blue-9/60 ring-offset-4 focus-visible:ring-2 sm:aspect-[16/9]",
					showCursor && "cursor-none",
				)}
			>
				{SIDES.map((side) => (
					<div
						key={side.key}
						ref={side.key === "after" ? afterRef : undefined}
						className="absolute inset-0"
						style={
							side.key === "after"
								? { clipPath: "inset(0 0 0 50%)" }
								: undefined
						}
					>
						{/* The windows were captured over this painting, placed the same
						way, so the glass is tinted by what's really behind it. */}
						<Image
							src="/backgrounds/miami.webp"
							alt=""
							fill
							sizes="(min-width: 1200px) 68rem, 94vw"
							draggable={false}
							className="object-cover"
						/>
						<Image
							ref={side.key === "before" ? windowRef : undefined}
							src={side.window}
							alt={`Cap's main window in ${side.version}, built with ${side.stack}`}
							width={WINDOW_WIDTH}
							height={side.height}
							sizes="(min-width: 1200px) 26rem, 40vw"
							draggable={false}
							className="absolute left-1/2 top-[9%] h-auto w-[40%] -translate-x-1/2 drop-shadow-[0_24px_36px_rgba(20,28,45,0.28)] sm:top-[9%] sm:w-[31%]"
						/>
					</div>
				))}

				<div
					ref={dividerRef}
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)]"
				/>

				<canvas
					ref={canvasRef}
					className="pointer-events-none absolute inset-0 size-full transition-opacity duration-150"
					style={{ opacity: showCursor ? 1 : 0 }}
				/>
			</div>
			<figcaption className="mx-auto mt-4 max-w-[40rem] px-2 text-center text-[14px] leading-relaxed text-gray-10">
				Cap's main window in 0.6.0 on the left and 0.6.1 on the right. Move
				across it to compare.
			</figcaption>
		</figure>
	);
}
