import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CapRecorder native capture session", () => {
	it("commits configuration before starting the capture session", () => {
		const source = readFileSync(
			join(process.cwd(), "modules/cap-recorder/ios/CapRecorderView.swift"),
			"utf8",
		);
		const configureSession = source.slice(
			source.indexOf("private func configureSession()"),
			source.indexOf("private func configureAudioSession()"),
		);
		const startRunningIndex = configureSession.indexOf(
			"self.session.startRunning()",
		);
		const commitConfigurationIndex = configureSession.lastIndexOf(
			"self.session.commitConfiguration()",
			startRunningIndex,
		);

		expect(configureSession).not.toMatch(
			/defer\s*\{[^}]*commitConfiguration\(\)/s,
		);
		expect(commitConfigurationIndex).toBeGreaterThan(-1);
		expect(startRunningIndex).toBeGreaterThan(commitConfigurationIndex);
	});
});
