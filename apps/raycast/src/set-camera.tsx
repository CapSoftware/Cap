import { LaunchProps, open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

interface Arguments {
  camera: string;
}

export default async function Command(props: LaunchProps<{ arguments: Arguments }>) {
  const camera = props.arguments.camera?.trim() || null;

  const url = buildDeeplinkUrl({
    set_camera: {
      camera: camera ? { ModelID: camera } : null,
    },
  });

  await open(url);
  await showHUD(camera ? `Switching camera to ${camera}` : "Disabling camera");
}
