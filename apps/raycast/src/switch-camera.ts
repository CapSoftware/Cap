import { LaunchProps } from "@raycast/api";
import { sendCapCommand } from "./utils";

export default async function Command(props: LaunchProps<{ arguments: { cameraId: string } }>) {
  await sendCapCommand("switch_camera", {
    camera: props.arguments.cameraId === "none" ? null : { DeviceID: props.arguments.cameraId }
  });
}
