const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]";

export const CLAIM = `inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[linear-gradient(90deg,#FFB36B_0%,#FF6F8E_52%,#C24BB3_100%)] px-6 text-[16px] font-medium tracking-[-0.01em] text-[#1A0A14] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),0_10px_40px_-10px_rgba(255,77,141,0.55)] transition-[transform,box-shadow,filter] duration-200 hover:-translate-y-px hover:brightness-105 aria-busy:cursor-progress aria-busy:saturate-[0.8] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent] ${FOCUS}`;

export const CLAIM_SMALL = "!h-9 !px-4 !text-[14px]";

export const GHOST = `inline-flex h-12 items-center justify-center gap-[9px] whitespace-nowrap rounded-full bg-[rgba(245,241,234,0.06)] px-5 text-[16px] text-[#F5F1EA] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.16)] transition-[background-color,box-shadow] duration-200 hover:bg-[rgba(245,241,234,0.1)] hover:shadow-[inset_0_0_0_1px_rgba(245,241,234,0.3)] ${FOCUS}`;

export const SUN_TEXT =
	"bg-[linear-gradient(90deg,#FFB36B_0%,#FF6F8E_52%,#C24BB3_100%)] bg-clip-text text-transparent";

export const DIM = "text-[rgba(245,241,234,0.64)]";

export const CARD =
	"rounded-[20px] bg-[linear-gradient(180deg,rgba(245,241,234,0.05),rgba(245,241,234,0.02))] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.08)]";
