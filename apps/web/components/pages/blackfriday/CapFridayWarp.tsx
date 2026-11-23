"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type WarpOrigin = { x: number; y: number };

const DURATION = 900;
const EASING = "cubic-bezier(0.76,0,0.24,1)";

// Covers the screen in the Cap Friday night from the point the code was
// applied, then hands over to the Cap Friday page, which starts on the same
// background and draws its mark in.
export function CapFridayWarp({
	origin,
	onCovered,
}: {
	origin: WarpOrigin;
	onCovered: () => void;
}) {
	const fill = useRef<HTMLDivElement>(null);
	const ring = useRef<HTMLDivElement>(null);
	const glow = useRef<HTMLDivElement>(null);
	const covered = useRef(onCovered);
	covered.current = onCovered;

	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			covered.current();
			return;
		}
		const radius = Math.hypot(
			Math.max(origin.x, window.innerWidth - origin.x),
			Math.max(origin.y, window.innerHeight - origin.y),
		);
		const at = `${origin.x}px ${origin.y}px`;
		const animations = [
			fill.current?.animate(
				[
					{ clipPath: `circle(0px at ${at})` },
					{ clipPath: `circle(${radius}px at ${at})` },
				],
				{ duration: DURATION, easing: EASING, fill: "forwards" },
			),
			ring.current?.animate(
				[
					{ width: "0px", height: "0px", opacity: 1 },
					{ opacity: 1, offset: 0.75 },
					{
						width: `${radius * 2}px`,
						height: `${radius * 2}px`,
						opacity: 0,
					},
				],
				{ duration: DURATION, easing: EASING, fill: "forwards" },
			),
			glow.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: 700,
				delay: DURATION * 0.5,
				easing: "ease-out",
				fill: "forwards",
			}),
		];
		const timer = window.setTimeout(() => covered.current(), DURATION * 0.85);
		return () => {
			window.clearTimeout(timer);
			for (const animation of animations) animation?.cancel();
		};
	}, [origin]);

	return createPortal(
		<div aria-hidden="true" className="fixed inset-0 z-[1000]">
			<div
				ref={fill}
				className="absolute inset-0 bg-[#0A0A0B]"
				style={{ clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` }}
			>
				<div
					ref={glow}
					className="absolute inset-x-0 top-0 h-[760px] bg-[radial-gradient(60%_55%_at_50%_0%,rgba(255,111,142,0.24),rgba(255,179,107,0.08)_45%,rgba(10,10,11,0)_75%)] opacity-0"
				/>
			</div>
			<div
				ref={ring}
				className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_#FF7A9C,0_0_28px_4px_rgba(255,77,141,0.65),inset_0_0_24px_rgba(255,214,140,0.45)]"
				style={{ left: origin.x, top: origin.y }}
			/>
		</div>,
		document.body,
	);
}
