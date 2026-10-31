import { BAND } from "./theme";

export const HALLOWEEN = true;

const NIGHT = "#2E2447";

export const HALLOWEEN_SKY = [
	"radial-gradient(80% 42% at 50% 76%, rgba(255,186,120,0.5) 0%, rgba(255,186,120,0) 72%)",
	`linear-gradient(180deg, #9C90D2 0%, #BFB2E2 30%, #E2D0E6 56%, #F3E1D8 76%, ${BAND} 94%)`,
].join(",");

export const BTN_PUMPKIN = [
	"group relative inline-flex h-[48px] items-center justify-center overflow-hidden rounded-[12px] px-6",
	"text-[16px] font-medium text-[#111111] [text-shadow:0_1px_0_rgba(255,255,255,0.45)]",
	"[background:linear-gradient(180deg,#FFF4E6_0%,#FFDDB4_52%,#FDC489_100%)]",
	"shadow-[inset_0_0_0_1px_rgba(214,116,36,0.7),inset_0_2px_3px_-1px_rgba(255,255,255,0.8),inset_0_-1px_1px_rgba(194,104,30,0.22),0_1px_2px_rgba(194,104,30,0.22),0_10px_24px_-10px_rgba(245,150,70,0.6)]",
	"after:pointer-events-none after:absolute after:inset-x-[3px] after:top-[3px] after:h-[44%] after:rounded-t-[9px] after:bg-gradient-to-b after:from-white/35 after:to-transparent",
	"transition-[filter,transform,box-shadow] duration-200 hover:brightness-[1.03] hover:shadow-[inset_0_0_0_1px_rgba(200,104,28,0.82),inset_0_2px_3px_-1px_rgba(255,255,255,0.85),inset_0_-1px_1px_rgba(194,104,30,0.22),0_2px_4px_rgba(194,104,30,0.24),0_14px_30px_-10px_rgba(245,150,70,0.7)]",
	"active:translate-y-px active:brightness-[0.98]",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0954A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F8FAFC]",
].join(" ");

export const PUMPKIN_CHIP = "#F6A25A";

export const Bat = ({ size }: { size: number }) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 64 36"
		width={size}
		height={Math.round((size * 36) / 64)}
		className="block overflow-visible"
	>
		<path
			className="ht-bat-wing ht-bat-wing-l"
			fill={NIGHT}
			d="M27 15C20 8 10 5 2 9c4 3 5 7 4 11 4-3 7-1 8 3 3-4 7-3 9 2 2-3 3-5 4-5Z"
		/>
		<path
			className="ht-bat-wing ht-bat-wing-r"
			fill={NIGHT}
			d="M37 15c7-7 17-10 25-6-4 3-5 7-4 11-4-3-7-1-8 3-3-4-7-3-9 2-2-3-3-5-4-5Z"
		/>
		<path
			fill={NIGHT}
			d="M26.5 14.5 27.6 6.5l3.4 5.8ZM37.5 14.5 36.4 6.5 33 12.3Z"
		/>
		<ellipse cx="32" cy="19" rx="7.2" ry="8" fill={NIGHT} />
		<circle cx="29.4" cy="17.6" r="1.7" fill="#FFFFFF" />
		<circle cx="34.6" cy="17.6" r="1.7" fill="#FFFFFF" />
		<circle cx="29.7" cy="17.9" r="0.8" fill={NIGHT} />
		<circle cx="34.9" cy="17.9" r="0.8" fill={NIGHT} />
		<path fill="#FFFFFF" d="M30.6 22.4h1.4l-.7 1.8ZM32 22.4h1.4l-.7 1.8Z" />
	</svg>
);

export const Ghost = ({ size }: { size: number }) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 60 70"
		width={size}
		height={Math.round((size * 70) / 60)}
		className="block overflow-visible drop-shadow-[0_8px_14px_rgba(46,36,71,0.18)]"
	>
		<path
			fill="#FFFFFF"
			stroke="rgba(46,36,71,0.1)"
			d="M30 4C15 4 6 15 6 30v30c0 4 3 5 6 2s5-3 7 1 6 4 8 0 4-4 6 0 6 4 8 0 4-4 7-1 6 2 6-2V30C54 15 45 4 30 4Z"
		/>
		<ellipse cx="22" cy="30" rx="3" ry="4.2" fill={NIGHT} />
		<ellipse cx="38" cy="30" rx="3" ry="4.2" fill={NIGHT} />
		<circle cx="23" cy="28.4" r="1" fill="#FFFFFF" />
		<circle cx="39" cy="28.4" r="1" fill="#FFFFFF" />
		<ellipse cx="16.5" cy="37.5" rx="3.6" ry="2" fill="#FFB8CB" />
		<ellipse cx="43.5" cy="37.5" rx="3.6" ry="2" fill="#FFB8CB" />
		<ellipse cx="30" cy="39.5" rx="2.4" ry="3" fill={NIGHT} />
	</svg>
);

const Spider = () => (
	<svg
		aria-hidden="true"
		viewBox="0 0 30 28"
		width={30}
		height={28}
		className="block overflow-visible"
	>
		<g
			fill="none"
			stroke={NIGHT}
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M10 11 4 6 1 9M9 14l-6-2-3 3M9 16l-6 2-2 4M10 18l-4 4-1 4" />
			<path d="m20 11 6-5 3 3m-8 5 6-2 3 3m-9 1 6 2 2 4m-9-4 4 4 1 4" />
		</g>
		<circle cx="15" cy="15" r="7" fill={NIGHT} />
		<circle cx="12.6" cy="13.6" r="1.9" fill="#FFFFFF" />
		<circle cx="17.4" cy="13.6" r="1.9" fill="#FFFFFF" />
		<circle cx="12.8" cy="14" r="0.9" fill={NIGHT} />
		<circle cx="17.6" cy="14" r="0.9" fill={NIGHT} />
		<path
			fill="none"
			stroke="#FFFFFF"
			strokeWidth="0.9"
			strokeLinecap="round"
			d="M13.4 17.6q1.6 1.3 3.2 0"
		/>
	</svg>
);

export const HalloweenMoon = () => (
	<div className="ht-moon">
		<div className="ht-moon-halo" />
		<div className="ht-moon-face" />
	</div>
);

type Flyer = {
	top: string;
	size: number;
	cross: number;
	offset: number;
	bob: number;
	reverse?: boolean;
	wide?: boolean;
};

const BATS: Flyer[] = [
	{ top: "12%", size: 34, cross: 26, offset: -6, bob: 2.1 },
	{ top: "24%", size: 22, cross: 34, offset: -21, bob: 1.7, reverse: true },
	{ top: "7%", size: 18, cross: 41, offset: -30, bob: 1.9, wide: true },
];

export const HalloweenCritters = () => (
	<>
		{BATS.map((bat) => (
			<div
				key={bat.top}
				className={`ht-bat-track ${bat.wide ? "" : "max-md:hidden"}`}
				style={{
					top: bat.top,
					left: -bat.size,
					width: `calc(100% + ${bat.size}px)`,
					animationDuration: `${bat.cross}s`,
					animationDelay: `${bat.offset}s`,
					animationDirection: bat.reverse ? "reverse" : "normal",
				}}
			>
				<div
					className="ht-bat-bob"
					style={{ animationDuration: `${bat.bob}s` }}
				>
					<Bat size={bat.size} />
				</div>
			</div>
		))}
		<div
			className="ht-ghost-spot hidden lg:block"
			style={{ left: "7%", top: "40%" }}
		>
			<div className="ht-ghost">
				<Ghost size={58} />
			</div>
		</div>
		<div
			className="ht-ghost-spot hidden lg:block"
			style={{ right: "8%", top: "56%" }}
		>
			<div className="ht-ghost" style={{ animationDelay: "-2.4s" }}>
				<Ghost size={40} />
			</div>
		</div>
		<div className="ht-spider hidden md:block" style={{ left: "13%" }}>
			<div className="ht-spider-thread" />
			<Spider />
		</div>
	</>
);

export const HALLOWEEN_CSS = `
.ht-halloween .ht-cloud img {
	filter: sepia(0.25) hue-rotate(215deg) saturate(1.4) brightness(0.98);
}
.ht-halloween .ht-rays { opacity: 0.4; }
.ht-halloween .ht-vignette {
	background: radial-gradient(75% 75% at 50% 50%, rgba(58,40,104,0) 50%, rgba(58,40,104,0.2) 100%);
}

.ht-moon {
	position: absolute;
	left: 79%;
	top: 5%;
	width: clamp(58px, 7vw, 100px);
	aspect-ratio: 1;
	animation: ht-moon-glow 7s ease-in-out infinite alternate;
}
.ht-moon-halo {
	position: absolute;
	inset: -130%;
	border-radius: 50%;
	background: radial-gradient(closest-side, rgba(255,246,222,0.75) 0%, rgba(255,228,190,0.3) 40%, rgba(255,228,190,0) 100%);
}
.ht-moon-face {
	position: absolute;
	inset: 0;
	border-radius: 50%;
	background:
		radial-gradient(circle at 34% 38%, rgba(240,222,180,0.6) 0 8%, transparent 8.5%),
		radial-gradient(circle at 62% 64%, rgba(240,222,180,0.5) 0 11%, transparent 11.5%),
		radial-gradient(circle at 66% 30%, rgba(240,222,180,0.5) 0 5%, transparent 5.5%),
		radial-gradient(circle at 30% 66%, rgba(240,222,180,0.45) 0 4%, transparent 4.5%),
		radial-gradient(circle at 40% 36%, #FFFEF6 0%, #FFF3D6 50%, #F9E5B9 72%);
	box-shadow: 0 0 44px 8px rgba(255,240,208,0.6);
}
@media (max-width: 767px) {
	.ht-moon { left: 86%; top: 6px; width: 46px; }
}
@keyframes ht-moon-glow {
	from { opacity: 0.88; transform: translate3d(0, 0, 0); }
	to { opacity: 1; transform: translate3d(0, -4px, 0); }
}

.ht-bat-track {
	position: absolute;
	will-change: transform;
	animation: ht-cloud-drift linear infinite;
}
.ht-bat-bob { animation: ht-bat-bob ease-in-out infinite alternate; }
@keyframes ht-bat-bob {
	from { transform: translate3d(0, -12px, 0) rotate(-6deg); }
	to { transform: translate3d(0, 12px, 0) rotate(5deg); }
}
.ht-bat-wing {
	transform-box: fill-box;
	animation: ht-bat-flap 0.28s ease-in-out infinite alternate;
}
.ht-bat-wing-l { transform-origin: 100% 40%; }
.ht-bat-wing-r { transform-origin: 0% 40%; animation-name: ht-bat-flap-r; }
@keyframes ht-bat-flap {
	from { transform: rotate(-22deg) scaleY(1); }
	to { transform: rotate(18deg) scaleY(0.7); }
}
@keyframes ht-bat-flap-r {
	from { transform: rotate(22deg) scaleY(1); }
	to { transform: rotate(-18deg) scaleY(0.7); }
}

.ht-ghost-spot { position: absolute; }
.ht-ghost { animation: ht-ghost-float 4.8s ease-in-out infinite alternate; }
@keyframes ht-ghost-float {
	from { transform: translate3d(0, -9px, 0) rotate(-5deg); opacity: 0.82; }
	to { transform: translate3d(0, 9px, 0) rotate(4deg); opacity: 0.95; }
}

.ht-spider {
	position: absolute;
	top: 0;
	transform-origin: 50% 0;
	animation: ht-spider-drop 6s ease-in-out infinite alternate;
}
.ht-spider-thread {
	width: 1px;
	height: 92px;
	margin: 0 auto -6px;
	background: linear-gradient(180deg, rgba(46,36,71,0) 0%, rgba(46,36,71,0.45) 40%);
}
@keyframes ht-spider-drop {
	from { transform: translate3d(0, -34px, 0) rotate(-3deg); }
	to { transform: translate3d(0, 6px, 0) rotate(3deg); }
}
`;
