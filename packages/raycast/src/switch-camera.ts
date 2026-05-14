import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

interface Arguments {
  camera: string;
}

export default async function Command(props: { arguments: Arguments }) {
  const { camera } = props.arguments;
  // We assume it's a DeviceID for simplicity in this Raycast command
  await triggerAction({ switch_camera: { camera: { device_id: camera } } });
  await showHUD(`Switching Camera to ${camera}`);
}
