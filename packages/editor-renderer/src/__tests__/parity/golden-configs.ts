import type { NormalizedRenderConfig } from "@cap/editor-render-spec";

export interface GoldenConfig {
	name: string;
	config: NormalizedRenderConfig;
	sourceWidth: number;
	sourceHeight: number;
}

const baseConfig: NormalizedRenderConfig = {
	aspectRatio: null,
	background: {
		source: { type: "color", value: [128, 128, 128], alpha: 1 },
		padding: 0,
		rounding: 0,
		roundingType: "rounded",
		crop: null,
		shadow: 0,
		advancedShadow: { size: 50, opacity: 50, blur: 50 },
	},
	timeline: null,
};

export const goldenConfigs: GoldenConfig[] = [
	{
		name: "01-color-no-padding",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [30, 30, 30], alpha: 1 },
			},
		},
	},

	{
		name: "02-color-padding-20",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [70, 130, 180], alpha: 1 },
				padding: 20,
			},
		},
	},

	{
		name: "03-color-padding-40",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [255, 100, 100], alpha: 1 },
				padding: 40,
			},
		},
	},

	{
		name: "04-aspect-wide",
		sourceWidth: 1280,
		sourceHeight: 720,
		config: {
			...baseConfig,
			aspectRatio: "wide",
			background: {
				...baseConfig.background,
				source: { type: "color", value: [50, 50, 100], alpha: 1 },
				padding: 10,
			},
		},
	},

	{
		name: "05-aspect-vertical",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			aspectRatio: "vertical",
			background: {
				...baseConfig.background,
				source: { type: "color", value: [100, 50, 100], alpha: 1 },
				padding: 15,
			},
		},
	},

	{
		name: "06-aspect-square",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			aspectRatio: "square",
			background: {
				...baseConfig.background,
				source: { type: "color", value: [50, 100, 50], alpha: 1 },
				padding: 10,
			},
		},
	},

	{
		name: "07-aspect-classic",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			aspectRatio: "classic",
			background: {
				...baseConfig.background,
				source: { type: "color", value: [100, 80, 60], alpha: 1 },
				padding: 10,
			},
		},
	},

	{
		name: "08-aspect-tall",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			aspectRatio: "tall",
			background: {
				...baseConfig.background,
				source: { type: "color", value: [60, 80, 100], alpha: 1 },
				padding: 10,
			},
		},
	},

	{
		name: "09-gradient-angle-0",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: {
					type: "gradient",
					from: [255, 0, 0],
					to: [0, 0, 255],
					angle: 0,
				},
				padding: 10,
			},
		},
	},

	{
		name: "10-gradient-angle-45",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: {
					type: "gradient",
					from: [255, 255, 0],
					to: [0, 255, 255],
					angle: 45,
				},
				padding: 10,
			},
		},
	},

	{
		name: "11-gradient-angle-90",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: {
					type: "gradient",
					from: [255, 0, 255],
					to: [0, 255, 0],
					angle: 90,
				},
				padding: 10,
			},
		},
	},

	{
		name: "12-gradient-angle-180",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: {
					type: "gradient",
					from: [128, 0, 128],
					to: [0, 128, 128],
					angle: 180,
				},
				padding: 10,
			},
		},
	},

	{
		name: "13-gradient-angle-270",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: {
					type: "gradient",
					from: [200, 100, 50],
					to: [50, 100, 200],
					angle: 270,
				},
				padding: 10,
			},
		},
	},

	{
		name: "14-rounded-low",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [180, 180, 180], alpha: 1 },
				padding: 15,
				rounding: 10,
				roundingType: "rounded",
			},
		},
	},

	{
		name: "15-rounded-medium",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [180, 180, 180], alpha: 1 },
				padding: 15,
				rounding: 50,
				roundingType: "rounded",
			},
		},
	},

	{
		name: "16-rounded-max",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [180, 180, 180], alpha: 1 },
				padding: 15,
				rounding: 100,
				roundingType: "rounded",
			},
		},
	},

	{
		name: "17-squircle-low",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [150, 200, 150], alpha: 1 },
				padding: 15,
				rounding: 10,
				roundingType: "squircle",
			},
		},
	},

	{
		name: "18-squircle-medium",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [150, 200, 150], alpha: 1 },
				padding: 15,
				rounding: 50,
				roundingType: "squircle",
			},
		},
	},

	{
		name: "19-squircle-max",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [150, 200, 150], alpha: 1 },
				padding: 15,
				rounding: 100,
				roundingType: "squircle",
			},
		},
	},

	{
		name: "20-shadow-light",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [220, 220, 220], alpha: 1 },
				padding: 20,
				rounding: 30,
				roundingType: "rounded",
				shadow: 30,
				advancedShadow: { size: 30, opacity: 50, blur: 30 },
			},
		},
	},

	{
		name: "21-shadow-medium",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [220, 220, 220], alpha: 1 },
				padding: 20,
				rounding: 30,
				roundingType: "rounded",
				shadow: 60,
				advancedShadow: { size: 50, opacity: 70, blur: 50 },
			},
		},
	},

	{
		name: "22-shadow-heavy",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [220, 220, 220], alpha: 1 },
				padding: 20,
				rounding: 30,
				roundingType: "rounded",
				shadow: 100,
				advancedShadow: { size: 100, opacity: 100, blur: 100 },
			},
		},
	},

	{
		name: "23-shadow-high-spread",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [200, 220, 240], alpha: 1 },
				padding: 25,
				rounding: 40,
				roundingType: "rounded",
				shadow: 80,
				advancedShadow: { size: 100, opacity: 60, blur: 30 },
			},
		},
	},

	{
		name: "24-shadow-high-blur",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [240, 220, 200], alpha: 1 },
				padding: 25,
				rounding: 40,
				roundingType: "rounded",
				shadow: 80,
				advancedShadow: { size: 30, opacity: 60, blur: 100 },
			},
		},
	},

	{
		name: "25-combined-gradient-squircle-shadow",
		sourceWidth: 1920,
		sourceHeight: 1080,
		config: {
			...baseConfig,
			aspectRatio: "wide",
			background: {
				source: {
					type: "gradient",
					from: [100, 50, 150],
					to: [150, 100, 50],
					angle: 135,
				},
				padding: 18,
				rounding: 70,
				roundingType: "squircle",
				crop: null,
				shadow: 70,
				advancedShadow: { size: 60, opacity: 80, blur: 60 },
			},
			timeline: null,
		},
	},

	{
		name: "26-small-source",
		sourceWidth: 320,
		sourceHeight: 240,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [80, 80, 120], alpha: 1 },
				padding: 15,
				rounding: 25,
				roundingType: "rounded",
				shadow: 50,
				advancedShadow: { size: 50, opacity: 70, blur: 50 },
			},
		},
	},

	{
		name: "27-non-standard-aspect",
		sourceWidth: 1000,
		sourceHeight: 600,
		config: {
			...baseConfig,
			background: {
				...baseConfig.background,
				source: { type: "color", value: [120, 80, 80], alpha: 1 },
				padding: 12,
				rounding: 35,
				roundingType: "squircle",
				shadow: 40,
				advancedShadow: { size: 45, opacity: 55, blur: 45 },
			},
		},
	},
];
