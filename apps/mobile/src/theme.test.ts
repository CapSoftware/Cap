import { describe, expect, it, vi } from "vitest";
import { colors } from "./theme";

vi.mock("react-native", () => ({
	StyleSheet: {
		create: <T extends Record<string, unknown>>(styles: T) => styles,
	},
}));

const webRadixColors = {
	gray: {
		gray1: "#fcfcfc",
		gray2: "#f9f9f9",
		gray3: "#f0f0f0",
		gray4: "#e8e8e8",
		gray5: "#e0e0e0",
		gray6: "#d9d9d9",
		gray7: "#cecece",
		gray8: "#bbbbbb",
		gray9: "#8d8d8d",
		gray10: "#838383",
		gray11: "#646464",
		gray12: "#202020",
	},
	blue: {
		blue1: "#fbfdff",
		blue2: "#f4faff",
		blue3: "#e6f4fe",
		blue4: "#d5efff",
		blue5: "#c2e5ff",
		blue6: "#acd8fc",
		blue7: "#8ec8f6",
		blue8: "#5eb1ef",
		blue9: "#0090ff",
		blue10: "#0588f0",
		blue11: "#0d74ce",
		blue12: "#113264",
	},
	red: {
		red1: "#fffcfc",
		red2: "#fff7f7",
		red3: "#feebec",
		red4: "#ffdbdc",
		red5: "#ffcdce",
		red6: "#fdbdbe",
		red7: "#f4a9aa",
		red8: "#eb8e90",
		red9: "#e5484d",
		red10: "#dc3e42",
		red11: "#ce2c31",
		red12: "#641723",
	},
};

describe("mobile theme", () => {
	it("matches the Radix color scales imported by Cap web", () => {
		expect(colors).toMatchObject({
			...webRadixColors.gray,
			...webRadixColors.blue,
			...webRadixColors.red,
		});
	});
});
