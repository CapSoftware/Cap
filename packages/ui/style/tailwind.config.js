module.exports = (__app, _options) => {
	// Function to generate color scales for Radix colors
	function getColorScale(name, alpha = false) {
		const scale = {};
		for (let i = 1; i <= 12; i++) {
			scale[i] = `var(--${name}-${i})`;
			// next line only needed if using alpha values
			if (alpha) scale[`a${i}`] = `var(--${name}-a${i})`;
		}

		return scale;
	}

	const config = {
		content: [
			`../../apps/*/pages/**/*.{js,ts,jsx,tsx,mdx}`,
			`../../apps/*/components/**/*.{js,ts,jsx,tsx,mdx}`,
			`../../apps/*/app/**/*.{js,ts,jsx,tsx,mdx}`,
			`../../apps/*/src/**/*.{js,ts,jsx,tsx,mdx}`,
			"../../packages/*/src/**/*.{ts,tsx,html,stories.tsx}",
		],
		theme: {
			screens: {
				xs: "480px",
				sm: "640px",
				md: "768px",
				lg: "1024px",
				xl: "1280px",
				"2xl": "1536px",
			},
			fontWeight: {
				thin: "300",
				hairline: "300",
				extralight: "300",
				light: "300",
				normal: "400",
				medium: "500",
				semibold: "500",
				bold: "600",
				extrabold: "600",
				"extra-bold": "600",
			},
			extend: {
				typography: {
					DEFAULT: {
						css: {
							strong: {
								fontWeight: "500",
							},
							b: {
								fontWeight: "500",
							},
							h1: {
								fontWeight: "500",
							},
							h2: {
								fontWeight: "500",
							},
							h3: {
								fontWeight: "500",
							},
							h4: {
								fontWeight: "500",
							},
							h5: {
								fontWeight: "500",
							},
							h6: {
								fontWeight: "500",
							},
						},
					},
				},
				colors: {
					gray: getColorScale("gray"),
					"gray-a": getColorScale("gray-a", true),
					blue: getColorScale("blue"),
					border: "hsl(var(--border))",
					input: "hsl(var(--input))",
					ring: "hsl(var(--ring))",
					background: "hsl(var(--background))",
					foreground: "hsl(var(--foreground))",
					primary: {
						DEFAULT: "var(--primary)",
						foreground: "hsl(var(--primary-foreground))",
					},
					"primary-2": "var(--primary-2)",
					"primary-3": "var(--primary-3)",
					secondary: {
						DEFAULT: "var(--secondary)",
						foreground: "var(--secondary-foreground)",
					},
					"secondary-2": "var(--secondary-2)",
					"secondary-3": "var(--secondary-3)",
					tertiary: "var(--tertiary)",
					"tertiary-2": "var(--tertiary-2)",
					"tertiary-3": "var(--tertiary-3)",
					filler: "var(--filler)",
					"filler-2": "var(--filler-2)",
					"filler-3": "var(--filler-3)",
					"filler-txt": "var(--filler-txt)",
					"hover-1": "var(--hover-1)",
					"hover-2": "var(--hover-2)",
					destructive: {
						DEFAULT: "hsl(var(--destructive))",
						foreground: "hsl(var(--destructive-foreground))",
					},
					muted: {
						DEFAULT: "hsl(var(--muted))",
						foreground: "hsl(var(--muted-foreground))",
					},
					accent: {
						DEFAULT: "hsl(var(--accent))",
						foreground: "hsl(var(--accent-foreground))",
					},
					popover: {
						DEFAULT: "hsl(var(--popover))",
						foreground: "hsl(var(--popover-foreground))",
					},
					card: {
						DEFAULT: "hsl(var(--card))",
						foreground: "hsl(var(--card-foreground))",
					},
					"black-transparent": {
						5: "rgba(18,22,31,0.05)",
						10: "rgba(18,22,31,0.1)",
						20: "rgba(18,22,31,0.2)",
						40: "rgba(18,22,31,0.4)",
						60: "rgba(18,22,31,0.6)",
						80: "rgba(18,22,31,0.8)",
					},
					"white-transparent": {
						5: "rgba(255,255,255,0.05)",
						10: "rgba(255,255,255,0.1)",
						20: "rgba(255,255,255,0.2)",
						40: "rgba(255,255,255,0.4)",
					},
					"blue-transparent": {
						10: "rgba(34,64,122,0.1)",
						20: "rgba(34,64,122,0.2)",
					},
					red: {
						50: "#FFEBEE",
						100: "#FFADBB",
						200: "#FF8599",
						300: "#FF4766",
						400: "#E03F5A",
					},
					"red-transparent": {
						20: "rgba(255,71,102,0.2)",
					},
				},
				backgroundImage: {
					"gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
					"gradient-conic":
						"conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
				},
				fontFamily: {
					primary: ["var(--font-sf-pro-display)", "sans-serif"],
				},
				keyframes: {
					flyEmoji: {
						"0%": {
							transform: "translateY(0) scale(1)",
							opacity: "0.7",
						},
						"100%": {
							transform: "translateY(-150px) scale(2.5)",
							opacity: "0",
						},
					},
					fadeIn: {
						from: { opacity: 0 },
						to: { opacity: 1 },
					},
					fadeOut: {
						from: { opacity: 1 },
						to: { opacity: 0 },
					},
					contentShow: {
						from: {
							opacity: 0,
							transform: "translate(-50%, -48%) scale(0.96)",
						},
						to: { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
					},
				},
				animation: {
					flyEmoji: "flyEmoji 1.5s forwards",
					fadeIn: "fadeIn 200ms ease-out",
					fadeOut: "fadeOut 150ms ease-in",
					contentShow: "contentShow 200ms ease-out",
				},
			},
		},
		plugins: [
			require("tailwindcss-animate"),
			require("@tailwindcss/typography"),
			require("@kobalte/tailwindcss"),
			require("tailwind-scrollbar"),
		],
	};
	return config;
};
