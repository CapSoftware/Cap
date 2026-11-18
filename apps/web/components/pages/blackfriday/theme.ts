export const INK = "#0A0A0B";

const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]";

export const CLAIM = `inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[linear-gradient(90deg,#FFB36B_0%,#FF6F8E_52%,#C24BB3_100%)] px-[22px] text-[16px] font-medium tracking-[-0.01em] text-[#1A0A14] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),0_10px_40px_-8px_rgba(255,77,141,0.6)] transition-[transform,box-shadow,filter] duration-200 hover:-translate-y-px hover:brightness-105 hover:saturate-[1.08] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24),0_14px_48px_-8px_rgba(255,77,141,0.75)] aria-busy:cursor-progress aria-busy:saturate-[0.8] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent] ${FOCUS}`;

export const CLAIM_SMALL = "!h-9 !px-[15px] !text-[14px]";

export const GHOST = `inline-flex h-12 items-center justify-center gap-[9px] whitespace-nowrap rounded-full bg-[rgba(10,10,11,0.42)] px-5 text-[16px] text-[#F5F1EA] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.28)] backdrop-blur-[14px] transition-[background-color,box-shadow] duration-200 hover:bg-[rgba(10,10,11,0.62)] hover:shadow-[inset_0_0_0_1px_rgba(245,241,234,0.5)] ${FOCUS}`;

export const NEON =
	"relative inline-block bg-[linear-gradient(180deg,#FFD68C_0%,#FF8078_38%,#FF4D8D_62%,#B0369F_100%)] bg-clip-text px-[0.16em] pb-[0.16em] pt-[0.06em] font-normal leading-[0.95] tracking-normal text-transparent [-webkit-text-stroke:0.6px_rgba(255,238,230,0.35)] [filter:drop-shadow(0_0_0.06em_rgba(255,77,141,0.85))_drop-shadow(0_0_0.28em_rgba(255,77,141,0.42))] animate-bf-title motion-reduce:animate-none";

export const SUN_TEXT =
	"bg-[linear-gradient(90deg,#FFB36B_0%,#FF6F8E_52%,#C24BB3_100%)] bg-clip-text text-transparent";

export const DIM = "text-[rgba(245,241,234,0.64)]";

export const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.1 -0.2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`;
