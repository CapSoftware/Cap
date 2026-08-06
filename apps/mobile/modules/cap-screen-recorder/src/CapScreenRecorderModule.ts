import { NativeModule, requireOptionalNativeModule } from "expo";
import type {
	CapScreenRecorderAvailability,
	CapScreenRecorderUpdates,
	PrepareScreenRecordingOptions,
} from "./CapScreenRecorder.types";

declare class CapScreenRecorderNativeModule extends NativeModule {
	getAvailability(): Promise<CapScreenRecorderAvailability>;
	prepareRecording(options: PrepareScreenRecordingOptions): Promise<void>;
	getRecordingUpdates(recordingId: string): Promise<CapScreenRecorderUpdates>;
	cancelRecording(recordingId: string): Promise<void>;
}

const getNativeModule = () => {
	const nativeModule =
		requireOptionalNativeModule<CapScreenRecorderNativeModule>(
			"CapScreenRecorder",
		);
	if (!nativeModule) {
		throw new Error("Screen recording is unavailable in this build.");
	}
	return nativeModule;
};

export const getScreenRecordingAvailability = async () => {
	const nativeModule =
		requireOptionalNativeModule<CapScreenRecorderNativeModule>(
			"CapScreenRecorder",
		);
	if (!nativeModule) {
		return {
			available: false,
			minimumSystemVersion: "15.1",
			reason: "Screen recording is unavailable in this build.",
		};
	}
	return nativeModule.getAvailability();
};

export const prepareScreenRecording = (
	options: PrepareScreenRecordingOptions,
) => getNativeModule().prepareRecording(options);

export const getScreenRecordingUpdates = (recordingId: string) =>
	getNativeModule().getRecordingUpdates(recordingId);

export const cancelScreenRecording = (recordingId: string) =>
	getNativeModule().cancelRecording(recordingId);
