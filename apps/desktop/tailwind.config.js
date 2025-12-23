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
				float: {
					"0%, 100%": {
						transform: "translateY(0) rotate(0deg)",
						opacity: "0.7",
					},
					"50%": {
						transform: "translateY(-20px) rotate(180deg)",
						opacity: "1",
					},
				},
				floatSlow: {
					"0%, 100%": { transform: "translateY(0) scale(1)" },
					"50%": { transform: "translateY(-30px) scale(1.1)" },
				},
				pulse3d: {
					"0%, 100%": { transform: "scale(1)", opacity: "0.8" },
					"50%": { transform: "scale(1.05)", opacity: "1" },
				},
				spin3d: {
					"0%": { transform: "rotateY(0deg)" },
					"100%": { transform: "rotateY(360deg)" },
				},
				gradientShift: {
					"0%": { backgroundPosition: "0% 50%" },
					"50%": { backgroundPosition: "100% 50%" },
					"100%": { backgroundPosition: "0% 50%" },
				},
				dash: {
					"0%": { strokeDasharray: "1, 150", strokeDashoffset: "0" },
					"50%": { strokeDasharray: "90, 150", strokeDashoffset: "-35" },
					"100%": { strokeDasharray: "90, 150", strokeDashoffset: "-124" },
				},
			},
			animation: {
				...baseConfig.theme?.extend?.animation,
				"gentle-bounce": "gentleBounce 1.5s ease-in-out infinite",
				shimmer: "shimmer 2s ease-in-out infinite",
				float: "float 6s ease-in-out infinite",
				"float-slow": "floatSlow 8s ease-in-out infinite",
				"float-delayed": "float 6s ease-in-out 2s infinite",
				pulse3d: "pulse3d 2s ease-in-out infinite",
				spin3d: "spin3d 3s linear infinite",
				"gradient-shift": "gradientShift 3s ease infinite",
				dash: "dash 1.5s ease-in-out infinite",
			},
		},
	},
};
