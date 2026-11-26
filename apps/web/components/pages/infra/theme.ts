export const MONO =
	"[font-family:var(--font-infra-mono),ui-monospace,SFMono-Regular,monospace]";

export const H_DISPLAY =
	"font-medium leading-[1.04] tracking-[-0.035em] text-[#E8ECF4]";

export const H_SECTION =
	"font-medium leading-[1.12] tracking-[-0.028em] text-[#E8ECF4]";

export const BODY = "text-[rgba(232,236,244,0.6)]";

const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.8)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050506]";

export const BTN_PRIMARY = [
	"inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[8px] px-4 text-[14px] font-medium text-[#050506]",
	"bg-[#E8ECF4] transition-colors duration-200 hover:bg-white",
	FOCUS,
].join(" ");

export const BTN_GHOST = [
	"inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[8px] px-4 text-[14px] text-[#E8ECF4]",
	"shadow-[inset_0_0_0_1px_rgba(222,230,246,0.16)] transition-[box-shadow,background-color] duration-200 hover:bg-[rgba(222,230,246,0.05)] hover:shadow-[inset_0_0_0_1px_rgba(222,230,246,0.28)]",
	FOCUS,
].join(" ");

export const TEXT_LINK =
	"underline decoration-[rgba(232,236,244,0.28)] underline-offset-[4px] transition-colors duration-200 hover:decoration-[#E8ECF4]";
