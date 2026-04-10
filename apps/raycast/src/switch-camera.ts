import { LaunchProps } from "@raycast/api";
import { sendCapCommand } from "./utils";

export default async function Command(props: LaunchProps<{ arguments: { cameraId: string } }>) {
  // DeviceOrModelID has a few formats depending on Cap's implementation
  // Passing it blindly string is difficult because Rust expects the exact Enum layout.
  // We will assume "camera" in JSON is null to disable, or an object if specific.
  // But for simple use, setting to an exact string from args.
  await sendCapCommand("switch_camera", {
    camera: props.arguments.cameraId === "none" ? null : props.arguments.cameraId
  });
}
