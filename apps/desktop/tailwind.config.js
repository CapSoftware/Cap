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
			},
			animation: {
				...baseConfig.theme?.extend?.animation,
				"gentle-bounce": "gentleBounce 1.5s ease-in-out infinite",
			},
		},
	},
};
