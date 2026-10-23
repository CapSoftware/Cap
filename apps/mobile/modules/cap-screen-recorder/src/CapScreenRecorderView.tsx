import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { CapScreenRecorderViewProps } from "./CapScreenRecorder.types";

const CapScreenRecorderView: ComponentType<CapScreenRecorderViewProps> =
	requireNativeView("CapScreenRecorder");

export default CapScreenRecorderView;
