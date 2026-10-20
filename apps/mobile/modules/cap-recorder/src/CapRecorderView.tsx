import { requireNativeView } from "expo";
import {
	Component,
	type ComponentType,
	createRef,
	type RefAttributes,
} from "react";
import type {
	CapRecorderViewProps,
	CapRecorderViewRef,
} from "./CapRecorder.types";

const NativeView: ComponentType<
	CapRecorderViewProps & RefAttributes<CapRecorderViewRef>
> = requireNativeView("CapRecorder");

export default class CapRecorderView
	extends Component<CapRecorderViewProps>
	implements CapRecorderViewRef
{
	private readonly nativeRef = createRef<CapRecorderViewRef>();

	startRecording(options: {
		recordingId: string;
		videoBitrate: number;
		segmentDurationSeconds: number;
	}) {
		return this.nativeRef.current?.startRecording(options) ?? Promise.resolve();
	}

	stopRecording() {
		return (
			this.nativeRef.current?.stopRecording() ??
			Promise.reject(new Error("The native recorder is unavailable."))
		);
	}

	render() {
		return <NativeView {...this.props} ref={this.nativeRef} />;
	}
}
