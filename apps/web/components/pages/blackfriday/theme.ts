const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]";

export const CLAIM = `group/claim relative isolate inline-flex h-14 items-center justify-center gap-4 overflow-hidden whitespace-nowrap rounded-full bg-[linear-gradient(180deg,#FFFFFF_0%,#F3EEE6_100%)] pl-7 pr-2 text-[17px] font-medium tracking-[-0.015em] text-[#141012] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(20,16,18,0.12),0_1px_2px_rgba(0,0,0,0.5),0_12px_34px_-12px_rgba(255,170,140,0.5)] transition-[transform,box-shadow] duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(20,16,18,0.12),0_2px_6px_rgba(0,0,0,0.5),0_22px_50px_-14px_rgba(255,160,130,0.75)] active:translate-y-0 active:scale-[0.98] aria-busy:cursor-progress aria-busy:opacity-80 motion-reduce:transition-none motion-reduce:hover:transform-none [-webkit-tap-highlight-color:transparent] ${FOCUS}`;

export const CLAIM_SMALL = "!h-10 !gap-2.5 !pl-4 !pr-1 !text-[14px]";

export const GHOST = `inline-flex h-11 items-center justify-center whitespace-nowrap rounded-[10px] px-5 text-[15px] text-[#F5F1EA] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.18)] transition-[background-color,box-shadow] duration-200 hover:bg-[rgba(245,241,234,0.05)] hover:shadow-[inset_0_0_0_1px_rgba(245,241,234,0.32)] ${FOCUS}`;

export const DIM = "text-[rgba(245,241,234,0.64)]";

export const CARD =
	"rounded-[20px] bg-[linear-gradient(180deg,rgba(245,241,234,0.05),rgba(245,241,234,0.02))] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.08)]";
