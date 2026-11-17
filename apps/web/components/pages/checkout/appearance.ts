import type { Appearance, CssFontSource } from "@stripe/stripe-js";

export const CHECKOUT_FONTS: CssFontSource[] = [
	{
		cssSrc:
			"https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap",
	},
];

const APPEARANCE: Appearance = {
	theme: "stripe",
	labels: "above",
	variables: {
		fontFamily: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
		fontSizeBase: "15px",
		colorPrimary: "#3D77C2",
		colorText: "#111111",
		colorTextSecondary: "rgba(17,17,17,0.6)",
		colorTextPlaceholder: "rgba(17,17,17,0.38)",
		colorBackground: "#FFFFFF",
		colorDanger: "#B4322E",
		borderRadius: "10px",
		spacingUnit: "4px",
		gridRowSpacing: "14px",
		focusOutline: "none",
		focusBoxShadow: "0 0 0 3px rgba(85,160,234,0.22)",
	},
	rules: {
		".Input": {
			border: "1px solid #D3DCE6",
			boxShadow: "0 1px 1px rgba(17,17,17,0.03)",
			padding: "11px 12px",
		},
		".Input:hover": {
			borderColor: "#B9C6D4",
		},
		".Input:focus": {
			borderColor: "#55A0EA",
			boxShadow: "0 0 0 3px rgba(85,160,234,0.22)",
		},
		".Input--invalid": {
			borderColor: "#B4322E",
			boxShadow: "none",
		},
		".Label": {
			fontSize: "13px",
			fontWeight: "500",
			color: "rgba(17,17,17,0.72)",
			marginBottom: "6px",
		},
		".Tab": {
			border: "1px solid #D3DCE6",
			boxShadow: "none",
		},
		".Tab:hover": {
			borderColor: "#B9C6D4",
		},
		".Tab--selected": {
			borderColor: "#55A0EA",
			backgroundColor: "#F5FAFE",
			boxShadow: "0 0 0 1px #55A0EA",
		},
		".Error": {
			fontSize: "13px",
		},
	},
};

// iOS zooms the page into any input under 16px, so touch devices get 16px
// fields inside the Stripe frames, like the inputs outside them.
export const checkoutAppearance = (touch: boolean): Appearance =>
	touch
		? {
				...APPEARANCE,
				rules: {
					...APPEARANCE.rules,
					".Input": { ...APPEARANCE.rules?.[".Input"], fontSize: "16px" },
				},
			}
		: APPEARANCE;
