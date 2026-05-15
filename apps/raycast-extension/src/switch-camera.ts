import { executeCapAction } from "./utils";

export default async function Command(props: { arguments: { camera_id: string; type?: string } }) {
  const isModel = props.arguments.type?.toLowerCase() === "model";
  await executeCapAction({
    switch_camera: {
      camera_id: isModel
        ? { ModelID: props.arguments.camera_id }
        : { DeviceID: props.arguments.camera_id },
    },
  });
}
