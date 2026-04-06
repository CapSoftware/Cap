import { executeCapAction } from "./utils";
import { LaunchProps } from "@raycast/api";

interface CameraArguments {
  id: string;
}

export default async function Command(props: LaunchProps<{ arguments: CameraArguments }>) {
  const { id } = props.arguments;
  await executeCapAction("camera", { id });
}
