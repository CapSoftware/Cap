import { executeCapAction } from "./utils";

export default async function Command(props: { arguments: { camera_id: string } }) {
  await executeCapAction({
    switch_camera: {
      camera_id: { DeviceID: props.arguments.camera_id },
    },
  });
}
