import { describe, expect, it } from "vitest";
import { createHowToSchema } from "@/utils/web-schema";

describe("createHowToSchema", () => {
	it("produces valid HowTo schema structure", () => {
		const schema = createHowToSchema({
			name: "How to Screen Record",
			description: "A guide to screen recording.",
			steps: [{ name: "Step 1", text: "Do the first thing." }],
		});

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("HowTo");
		expect(schema.name).toBe("How to Screen Record");
		expect(schema.description).toBe("A guide to screen recording.");
	});

	it("maps each step to a HowToStep with correct position", () => {
		const steps = [
			{ name: "Download", text: "Download the app." },
			{ name: "Install", text: "Install the app." },
			{ name: "Record", text: "Click record." },
		];
		const schema = createHowToSchema({
			name: "How to Record",
			description: "A guide.",
			steps,
		});

		expect(schema.step).toHaveLength(3);
		expect(schema.step[0]).toEqual({
			"@type": "HowToStep",
			position: 1,
			name: "Download",
			text: "Download the app.",
		});
		expect(schema.step[1].position).toBe(2);
		expect(schema.step[2].position).toBe(3);
	});

	it("uses default totalTime of PT2M when not provided", () => {
		const schema = createHowToSchema({
			name: "Test",
			description: "Test.",
			steps: [],
		});

		expect(schema.totalTime).toBe("PT2M");
	});

	it("uses provided totalTime when specified", () => {
		const schema = createHowToSchema({
			name: "Test",
			description: "Test.",
			totalTime: "PT5M",
			steps: [],
		});

		expect(schema.totalTime).toBe("PT5M");
	});

	it("handles empty steps array", () => {
		const schema = createHowToSchema({
			name: "Test",
			description: "Test.",
			steps: [],
		});

		expect(schema.step).toHaveLength(0);
		expect(Array.isArray(schema.step)).toBe(true);
	});

	it("produces JSON-serializable output", () => {
		const schema = createHowToSchema({
			name: "How to Screen Record on Mac",
			description: "Learn how to screen record.",
			totalTime: "PT2M",
			steps: [
				{
					name: "Download and install Cap",
					text: "Download Cap for free from cap.so/download.",
				},
				{
					name: "Start recording",
					text: "Click the record button.",
				},
			],
		});

		expect(() => JSON.stringify(schema)).not.toThrow();

		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("HowTo");
		expect(parsed["@context"]).toBe("https://schema.org");
		expect(parsed.step).toHaveLength(2);
	});

	it("applies schema to how-to-screen-record page steps", () => {
		const howToSteps = [
			{
				name: "Download and install Cap",
				text: "Download Cap for free from cap.so/download for Mac or Windows.",
			},
			{
				name: "Choose your recording settings",
				text: "Open Cap and select your recording source.",
			},
			{
				name: "Start recording your screen",
				text: "Click the record button to begin capturing your screen.",
			},
			{
				name: "Share or export your recording",
				text: "Stop the recording when finished.",
			},
		];
		const schema = createHowToSchema({
			name: "How to Screen Record on Mac, Windows & Chrome",
			description:
				"Learn how to screen record with audio on Mac, Windows, or in your browser using Cap.",
			totalTime: "PT2M",
			steps: howToSteps,
		});

		expect(schema["@type"]).toBe("HowTo");
		expect(schema.step).toHaveLength(4);
		expect(schema.step[0].name).toBe("Download and install Cap");
		expect(schema.step[3].position).toBe(4);
	});
});
