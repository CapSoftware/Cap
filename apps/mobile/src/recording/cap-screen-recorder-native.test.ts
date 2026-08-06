import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareScreenRecording } from "../../modules/cap-screen-recorder/src/CapScreenRecorderModule";

const expoModuleState = vi.hoisted(() => ({
	requireOptionalNativeModule: vi.fn(),
}));

vi.mock("expo", () => ({
	NativeModule: class {},
	requireOptionalNativeModule: expoModuleState.requireOptionalNativeModule,
}));

const moduleRoot = join(process.cwd(), "modules/cap-screen-recorder");
const readModuleFile = (path: string) =>
	readFileSync(join(moduleRoot, path), "utf8");

describe("CapScreenRecorder native ReplayKit capture", () => {
	it("keeps the record route loadable while a new native binary installs", () => {
		expoModuleState.requireOptionalNativeModule.mockReturnValue(null);

		expect(() =>
			prepareScreenRecording({
				recordingId: "recording-id",
				width: 720,
				height: 1280,
				videoBitrate: 1_800_000,
				segmentDurationSeconds: 2,
				maximumDurationSeconds: null,
			}),
		).toThrow("Screen recording is unavailable in this build.");
		expect(expoModuleState.requireOptionalNativeModule).toHaveBeenCalledWith(
			"CapScreenRecorder",
		);
	});

	it("uses the preferred ReplayKit broadcast extension from one native control", () => {
		const view = readModuleFile("ios/CapScreenRecorderView.swift");
		const plugin = readModuleFile("plugin/withCapScreenRecorder.js");
		const sampleHandler = readModuleFile(
			"extension/CapScreenBroadcast/SampleHandler.swift",
		);

		expect(view).toContain("RPSystemBroadcastPickerView");
		expect(view).toContain("picker.preferredExtension");
		expect(view).toContain("picker.showsMicrophoneButton = true");
		expect(sampleHandler).toContain("RPBroadcastSampleHandler");
		expect(sampleHandler).toContain("case .video:");
		expect(sampleHandler).toContain("case .audioMic:");
		expect(plugin).toContain('const targetName = "CapScreenBroadcast"');
		expect(plugin).toContain("project.addTarget(");
		expect(plugin).toContain('"ReplayKit.framework"');
	});

	it("bounds capture work and copies ReplayKit samples before async encoding", () => {
		const writer = readModuleFile(
			"extension/CapScreenBroadcast/SegmentedScreenWriter.swift",
		);

		expect(writer).toContain("DispatchSemaphore(value: 2)");
		expect(writer).toContain("DispatchSemaphore(value: 8)");
		expect(writer).toContain("CMSampleBufferCreateCopy(");
		expect(writer).toContain("CMTime(value: 1, timescale: 30)");
		expect(writer).toContain("CVPixelBufferPoolCreatePixelBuffer(");
		expect(writer).toContain(
			"CIContext(options: [.cacheIntermediates: false])",
		);
		expect(writer).toContain("AVVideoCodecType.h264");
		expect(writer).toContain("AVVideoAverageBitRateKey");
		expect(writer).toContain("AVEncoderBitRateKey: 96_000");
		expect(writer).toContain(".mpeg4CMAFCompliant");
		expect(writer).toContain("preferredOutputSegmentInterval");
	});

	it("keeps network and credentials out of the memory-constrained extension", () => {
		const sampleHandler = readModuleFile(
			"extension/CapScreenBroadcast/SampleHandler.swift",
		);
		const writer = readModuleFile(
			"extension/CapScreenBroadcast/SegmentedScreenWriter.swift",
		);
		const combinedExtension = `${sampleHandler}\n${writer}`;

		expect(combinedExtension).not.toContain("URLSession");
		expect(combinedExtension).not.toContain("apiKey");
		expect(combinedExtension).not.toContain("Keychain");
		expect(combinedExtension).not.toContain("import Security");
	});

	it("finalizes local fragments and recovers interrupted broadcasts", () => {
		const module = readModuleFile("ios/CapScreenRecorderModule.swift");
		const sampleHandler = readModuleFile(
			"extension/CapScreenBroadcast/SampleHandler.swift",
		);
		const writer = readModuleFile(
			"extension/CapScreenBroadcast/SegmentedScreenWriter.swift",
		);

		expect(sampleHandler).toContain("override func broadcastFinished()");
		expect(sampleHandler).toContain("completion.wait(timeout:");
		expect(writer).toContain('manifest.status = "finished"');
		expect(writer).toContain("extendStaticVideoFrame()");
		expect(module).toContain("recoverExistingConfiguration");
		expect(module).toContain("recoverStalledRecording");
		expect(module).toContain('manifest.status = "finished"');
	});

	it("supports iOS 15.1 without unsupported screen-recording entitlements", () => {
		const appConfig = readFileSync(
			join(process.cwd(), "app.config.js"),
			"utf8",
		);
		const module = readModuleFile("ios/CapScreenRecorderModule.swift");
		const plugin = readModuleFile("plugin/withCapScreenRecorder.js");
		const podspec = readModuleFile("ios/CapScreenRecorder.podspec");
		const extensionInfo = readModuleFile(
			"extension/CapScreenBroadcast/Info.plist",
		);

		expect(appConfig).not.toContain("--show-sdk-version");
		expect(appConfig).toContain(
			'extensionBundleIdentifier: "so.cap.mobile.screen-broadcast"',
		);
		expect(module).toContain('"minimumSystemVersion": "15.1"');
		expect(plugin).toContain(
			'delete entitlementsConfig.modResults[\n\t\t\t"com.apple.developer.screen-recording"',
		);
		expect(plugin).toContain('mode !== "audio" && mode !== "screen-capture"');
		expect(plugin).toContain("com.apple.security.application-groups");
		expect(podspec).toContain("ReplayKit");
		expect(extensionInfo).toContain("RPBroadcastProcessModeSampleBuffer");
		expect(extensionInfo).toContain("com.apple.broadcast-services-upload");
	});
});
