export const BONE = "#ECE8E1";

export const NIGHT = "#0E0F10";

export const GLASS = "rgba(20,21,23,0.72)";

export const SANS =
	"[font-family:var(--font-ht-sans),ui-sans-serif,system-ui,sans-serif]";

export const MONO = "[font-family:var(--font-ht-mono),ui-monospace,monospace]";

export const H_DISPLAY = `${SANS} font-normal leading-[0.98] tracking-[-0.035em] text-[#ECE8E1]`;

export const H_SECTION = `${SANS} font-normal leading-[1.02] tracking-[-0.03em] text-[#ECE8E1]`;

export const BODY = "text-[rgba(236,232,225,0.62)]";

export const MUTED = "text-[rgba(236,232,225,0.42)]";

export const HAIRLINE = "border-[rgba(236,232,225,0.09)]";

export const BTN_PRIMARY = [
	"inline-flex h-12 items-center justify-center whitespace-nowrap rounded-[10px] px-6 text-[15.5px] font-medium text-[#0E0F10]",
	"bg-[#ECE8E1] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_0_0_1px_rgba(236,232,225,0.5),0_12px_32px_-12px_rgba(236,232,225,0.35)]",
	"transition-[background-color,transform] duration-200 hover:bg-white active:translate-y-px",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0E0F10]",
].join(" ");

export const BTN_GHOST = [
	"inline-flex h-12 items-center justify-center whitespace-nowrap rounded-[10px] px-6 text-[15.5px] text-[#ECE8E1]",
	"bg-[rgba(236,232,225,0.04)] shadow-[inset_0_1px_0_rgba(236,232,225,0.08),0_0_0_1px_rgba(236,232,225,0.14)]",
	"transition-colors duration-200 hover:bg-[rgba(236,232,225,0.08)]",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0E0F10]",
].join(" ");

export const GLASS_PANEL =
	"bg-[rgba(20,21,23,0.72)] shadow-[inset_0_1px_0_rgba(236,232,225,0.10),0_0_0_1px_rgba(236,232,225,0.09),0_40px_80px_-40px_rgba(0,0,0,0.9)] backdrop-blur-xl";
