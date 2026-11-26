import { describe, expect, it } from "vitest";
import { isCapSpeechService } from "@/lib/meetings/speech";

describe("isCapSpeechService", () => {
	it.each([
		"https://speech.example/asr",
		"http://127.0.0.1:8090",
		"https://notassemblyai.com",
	])("accepts %s", (url) => {
		expect(isCapSpeechService(url)).toBe(true);
	});

	it.each([
		undefined,
		"",
		"https://assemblyai.com",
		"https://api.assemblyai.com",
		"https://api.eu.assemblyai.com/v2",
		"https://API.ASSEMBLYAI.COM",
		"https://api.assemblyai.com.",
		"ftp://speech.example",
		"speech.example",
	])("rejects %s", (url) => {
		expect(isCapSpeechService(url)).toBe(false);
	});
});
