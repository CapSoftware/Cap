const baseConfig = require("@cap/ui-solid/tailwind");

/** @type {import('tailwindcss').Config} */
module.exports = {
	...baseConfig,
	theme: {
		...baseConfig.theme,
		extend: {
			...baseConfig.theme?.extend,
			keyframes: {
				...baseConfig.theme?.extend?.keyframes,
				gentleBounce: {
					"0%, 100%": { transform: "translateY(0)" },
					"50%": { transform: "translateY(-4px)" },
				},
				shimmer: {
					"0%": { transform: "translateX(-100%)" },
					"100%": { transform: "translateX(100%)" },
				},
			},
			animation: {
				...baseConfig.theme?.extend?.animation,
				"gentle-bounce": "gentleBounce 1.5s ease-in-out infinite",
				shimmer: "shimmer 2s ease-in-out infinite",
			},
		},
	},
};
