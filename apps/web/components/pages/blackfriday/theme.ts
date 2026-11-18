const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]";

export const CLAIM = `inline-flex h-11 items-center justify-center whitespace-nowrap rounded-[10px] bg-[#F5F1EA] px-5 text-[15px] font-medium text-[#0A0A0B] transition-colors duration-200 hover:bg-white aria-busy:cursor-progress aria-busy:opacity-80 [-webkit-tap-highlight-color:transparent] ${FOCUS}`;

export const CLAIM_SMALL = "!h-9 !rounded-[8px] !px-4 !text-[14px]";

export const GHOST = `inline-flex h-11 items-center justify-center whitespace-nowrap rounded-[10px] px-5 text-[15px] text-[#F5F1EA] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.18)] transition-[background-color,box-shadow] duration-200 hover:bg-[rgba(245,241,234,0.05)] hover:shadow-[inset_0_0_0_1px_rgba(245,241,234,0.32)] ${FOCUS}`;

export const DIM = "text-[rgba(245,241,234,0.64)]";

export const CARD =
	"rounded-[20px] bg-[linear-gradient(180deg,rgba(245,241,234,0.05),rgba(245,241,234,0.02))] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.08)]";
