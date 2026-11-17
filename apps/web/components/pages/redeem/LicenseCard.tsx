"use client";

import { LogoBadge } from "@cap/ui";
import { classNames } from "@cap/utils/helpers";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { MODE_THEME, MONO, meshStyle } from "@/components/pages/HomeTwo/theme";
import { useReducedMotion } from "@/components/pages/HomeTwo/visibility";
import {
	groupLicenseKey,
	LICENSE_KEY_LENGTH,
	LICENSE_KEY_SLOTS,
	type LicenseDuration,
} from "@/lib/license-redeem";

const SCRAMBLE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SCRAMBLE_LEAD_MS = 260;
const SCRAMBLE_STEP_MS = 22;

const scrambled = (target: string, elapsed: number) =>
	Array.from(target, (char, index) =>
		elapsed >= SCRAMBLE_LEAD_MS + index * SCRAMBLE_STEP_MS
			? char
			: SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)],
	).join("");

// The key settles left to right out of noise the first time it is shown, so
// the reveal reads as the license being written onto the card.
const useSettledKey = (licenseKey: string | null, animate: boolean) => {
	const [shown, setShown] = useState(licenseKey);
	const settled = useRef<string | null>(null);

	useEffect(() => {
		if (!licenseKey || !animate || settled.current === licenseKey) {
			settled.current = licenseKey;
			setShown(licenseKey);
			return;
		}
		settled.current = licenseKey;
		const total = SCRAMBLE_LEAD_MS + licenseKey.length * SCRAMBLE_STEP_MS;
		const start = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			const elapsed = now - start;
			if (elapsed >= total) {
				setShown(licenseKey);
				return;
			}
			setShown(scrambled(licenseKey, elapsed));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [licenseKey, animate]);

	return shown;
};

const MASKED_GROUPS = Array.from({ length: LICENSE_KEY_LENGTH / 5 }, () =>
	"•".repeat(5),
);

const DURATION_LABEL: Record<LicenseDuration, string> = {
	lifetime: "Lifetime",
	yearly: "1 year",
};

const Bow = () => {
	const id = useId();
	const loop = `${id}-loop`;
	const tail = `${id}-tail`;
	const knot = `${id}-knot`;
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 140 100"
			className="rd-bow absolute left-1/2 top-1/2 w-[34%] min-w-[104px]"
			fill="none"
		>
			<path
				d="M64 52 45 92l13-6 6 11 9-43Z"
				fill={`url(#${tail})`}
				stroke="rgba(61,119,194,0.22)"
				strokeWidth="1"
				strokeLinejoin="round"
			/>
			<path
				d="m76 52 19 40-13-6-6 11-9-43Z"
				fill={`url(#${tail})`}
				stroke="rgba(61,119,194,0.22)"
				strokeWidth="1"
				strokeLinejoin="round"
			/>
			<path
				d="M70 46C52 13 23 3 10 15-3 27 8 51 30 53c16 1 30-2 40-7Z"
				fill={`url(#${loop})`}
				stroke="rgba(61,119,194,0.24)"
				strokeWidth="1"
			/>
			<path
				d="M70 46c18-33 47-43 60-31 13 12 2 36-20 38-16 1-30-2-40-7Z"
				fill={`url(#${loop})`}
				stroke="rgba(61,119,194,0.24)"
				strokeWidth="1"
			/>
			<path
				d="M61 43C49 27 32 20 24 26c-7 6 0 17 12 18 9 1 18 0 25-1Z"
				fill="rgba(61,119,194,0.15)"
			/>
			<path
				d="M79 43c12-16 29-23 37-17 7 6 0 17-12 18-9 1-18 0-25-1Z"
				fill="rgba(61,119,194,0.15)"
			/>
			<rect
				x="57"
				y="33"
				width="26"
				height="26"
				rx="10"
				fill={`url(#${knot})`}
				stroke="rgba(61,119,194,0.24)"
				strokeWidth="1"
			/>
			<defs>
				<linearGradient id={loop} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#FFFFFF" />
					<stop offset="1" stopColor="#D9E7F8" />
				</linearGradient>
				<linearGradient id={tail} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#DCE8F8" />
					<stop offset="1" stopColor="#FFFFFF" />
				</linearGradient>
				<linearGradient id={knot} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#FFFFFF" />
					<stop offset="1" stopColor="#E0EBF9" />
				</linearGradient>
			</defs>
		</svg>
	);
};

export const LicenseCard = ({
	wrapped,
	licenseKey,
	owner,
	duration,
	className,
}: {
	wrapped: boolean;
	licenseKey: string | null;
	owner: string | null;
	duration: LicenseDuration | null;
	className?: string;
}) => {
	const reducedMotion = useReducedMotion();
	const tiltRef = useRef<HTMLDivElement | null>(null);
	const shownKey = useSettledKey(wrapped ? null : licenseKey, !reducedMotion);
	const groups = shownKey ? groupLicenseKey(shownKey) : MASKED_GROUPS;

	const tilt = (event: PointerEvent<HTMLDivElement>) => {
		const el = tiltRef.current;
		if (!el || reducedMotion || event.pointerType !== "mouse") return;
		const rect = el.getBoundingClientRect();
		const x = (event.clientX - rect.left) / rect.width;
		const y = (event.clientY - rect.top) / rect.height;
		el.style.setProperty("--rd-ry", `${(x - 0.5) * 9}deg`);
		el.style.setProperty("--rd-rx", `${(0.5 - y) * 7}deg`);
		el.style.setProperty("--rd-gx", `${x * 100}%`);
		el.style.setProperty("--rd-gy", `${y * 100}%`);
		el.style.setProperty("--rd-glare", "1");
	};

	const settle = () => {
		const el = tiltRef.current;
		if (!el) return;
		el.style.setProperty("--rd-ry", "0deg");
		el.style.setProperty("--rd-rx", "0deg");
		el.style.setProperty("--rd-glare", "0");
	};

	return (
		<div
			className={classNames("rd-stage", className)}
			onPointerMove={tilt}
			onPointerLeave={settle}
		>
			<style href="rd-license-card" precedence="default">
				{CSS}
			</style>
			<div
				ref={tiltRef}
				className={classNames("rd-card", wrapped ? "rd-wrapped" : "rd-open")}
			>
				<div
					className="rd-face absolute inset-0 flex flex-col justify-between overflow-hidden rounded-[22px] p-5 sm:p-6"
					style={meshStyle(MODE_THEME.screenshot)}
				>
					<div className="flex items-center justify-between gap-3">
						<span className="flex items-center gap-2.5">
							<LogoBadge className="size-7 shrink-0" />
							<span className="text-[15px] font-medium leading-none tracking-[-0.01em] text-[#111111]">
								Desktop License
							</span>
						</span>
						{duration ? (
							<span className="rounded-full bg-white/70 px-2.5 py-[6px] text-[12px] font-medium leading-none tracking-[-0.01em] text-[#2C7A5B] shadow-[0_0_0_1px_rgba(63,153,116,0.18)]">
								{DURATION_LABEL[duration]}
							</span>
						) : null}
					</div>

					<p
						aria-hidden="true"
						className={classNames(
							MONO,
							"grid w-fit grid-cols-3 gap-x-[0.7em] gap-y-2 text-[15px] leading-none text-[#111111] min-[380px]:text-[16px] sm:flex sm:text-[16.5px]",
							shownKey ? "" : "text-[rgba(17,17,17,0.34)]",
						)}
					>
						{LICENSE_KEY_SLOTS.map((slot, index) => (
							<span key={slot}>{groups[index]}</span>
						))}
					</p>

					<div className="flex items-end justify-between gap-3">
						<span className="min-w-0">
							<span className="block text-[12.5px] leading-none text-[rgba(17,17,17,0.5)]">
								Licensed to
							</span>
							<span className="mt-1.5 block truncate text-[14.5px] leading-tight text-[#111111]">
								{owner ?? "You, in a moment"}
							</span>
						</span>
						<span className="shrink-0 text-[12.5px] leading-none text-[rgba(17,17,17,0.5)]">
							Cap.so
						</span>
					</div>
					<span aria-hidden="true" className="rd-sheen" />
					<span aria-hidden="true" className="rd-glare" />
				</div>

				<div aria-hidden="true" className="rd-cover absolute inset-0">
					<span className="rd-paper rd-paper-left" />
					<span className="rd-paper rd-paper-right" />
					<span className="rd-ribbon rd-ribbon-v" />
					<span className="rd-ribbon rd-ribbon-h" />
					<Bow />
				</div>
			</div>
		</div>
	);
};

const PAPER = [
	"repeating-linear-gradient(135deg, rgba(255,255,255,0.2) 0 2px, rgba(255,255,255,0) 2px 15px)",
	"radial-gradient(90% 110% at 4% 0%, #7DB3F2 0%, rgba(125,179,242,0) 62%)",
	"radial-gradient(80% 100% at 100% 100%, #B9C8F6 0%, rgba(185,200,246,0) 60%)",
	"linear-gradient(160deg, #9CC6F5 0%, #85B6EE 100%)",
].join(",");

const CSS = `
/* Set by the page's inline script when the visitor arrived with a gift link
   or from checkout, so the empty form is never shown before the real state. */
.rd-pending [data-rd-boot] { visibility: hidden; }
.rd-stage {
	perspective: 1100px;
	width: 100%;
	animation: rd-arrive 0.9s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.rd-card {
	position: relative;
	width: 100%;
	aspect-ratio: 1.586;
	transform: rotateX(var(--rd-rx, 0deg)) rotateY(var(--rd-ry, 0deg));
	transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
	filter: drop-shadow(0 30px 34px rgba(31, 62, 110, 0.2)) drop-shadow(0 4px 8px rgba(31, 62, 110, 0.1));
}
@keyframes rd-arrive {
	from { opacity: 0; transform: translate3d(0, 22px, 0) scale(0.96); }
	to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}

.rd-face {
	box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.75), inset 0 1px 0 1px rgba(255, 255, 255, 0.9);
	transition: transform 0.9s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}
.rd-wrapped .rd-face { transform: scale(0.965); }

.rd-sheen {
	position: absolute;
	inset: -40% -60%;
	background: linear-gradient(105deg, rgba(255,255,255,0) 42%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 58%);
	transform: translateX(-70%);
	pointer-events: none;
}
.rd-open .rd-sheen { animation: rd-sheen 1.25s cubic-bezier(0.4, 0, 0.2, 1) 0.45s both; }
@keyframes rd-sheen {
	from { transform: translateX(-70%); }
	to { transform: translateX(70%); }
}
.rd-glare {
	position: absolute;
	inset: 0;
	background: radial-gradient(42% 52% at var(--rd-gx, 50%) var(--rd-gy, 50%), rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 100%);
	opacity: var(--rd-glare, 0);
	transition: opacity 0.4s ease;
	pointer-events: none;
}

.rd-cover { pointer-events: none; }
.rd-paper {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 50%;
	background-image: ${PAPER};
	background-size: 200% 100%;
	box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
	transition: transform 0.95s cubic-bezier(0.5, 0, 0.2, 1), opacity 0.6s ease 0.3s;
}
.rd-paper-left {
	left: 0;
	border-radius: 22px 0 0 22px;
	background-position: left center;
	transform-origin: 0% 100%;
}
.rd-paper-right {
	right: 0;
	border-radius: 0 22px 22px 0;
	background-position: right center;
	transform-origin: 100% 100%;
}
.rd-open .rd-paper-left { transform: translate3d(-58%, 8%, 0) rotate(-9deg); opacity: 0; }
.rd-open .rd-paper-right { transform: translate3d(58%, 8%, 0) rotate(9deg); opacity: 0; }

.rd-ribbon {
	position: absolute;
	background: linear-gradient(90deg, #F2F7FD 0%, #FFFFFF 38%, #FFFFFF 62%, #E9F1FB 100%);
	box-shadow: 0 1px 3px rgba(31, 75, 135, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.9);
	transition: transform 0.6s cubic-bezier(0.6, 0, 0.3, 1), opacity 0.35s ease 0.3s;
}
.rd-ribbon-v {
	top: 0;
	bottom: 0;
	left: 50%;
	width: 8.5%;
	margin-left: -4.25%;
	transform-origin: 50% 0%;
}
.rd-ribbon-h {
	left: 0;
	right: 0;
	top: 50%;
	height: 13.5%;
	margin-top: -6.75%;
	background: linear-gradient(180deg, #F2F7FD 0%, #FFFFFF 38%, #FFFFFF 62%, #E9F1FB 100%);
	transform-origin: 0% 50%;
}
.rd-open .rd-ribbon-v { transform: scaleY(0); opacity: 0; }
.rd-open .rd-ribbon-h { transform: scaleX(0); opacity: 0; }

.rd-bow {
	transform: translate(-50%, -47%);
	filter: drop-shadow(0 3px 5px rgba(31, 75, 135, 0.24));
	transition: transform 0.55s cubic-bezier(0.5, -0.4, 0.4, 1), opacity 0.3s ease 0.2s;
}
.rd-open .rd-bow { transform: translate(-50%, -110%) scale(0.5) rotate(-14deg); opacity: 0; }

@media (prefers-reduced-motion: reduce) {
	.rd-stage { animation: none; }
	.rd-card { transition: none; }
	.rd-face, .rd-paper, .rd-ribbon, .rd-bow { transition: opacity 0.2s ease; }
	.rd-open .rd-paper-left, .rd-open .rd-paper-right, .rd-open .rd-ribbon-v, .rd-open .rd-ribbon-h { transform: none; }
	.rd-open .rd-bow { transform: translate(-50%, -47%); }
	.rd-open .rd-sheen { animation: none; }
}
`;
