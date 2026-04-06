import { executeCapAction } from "./utils";
import { LaunchProps } from "@raycast/api";

interface MicArguments {
  name: string;
}

export default async function Command(props: LaunchProps<{ arguments: MicArguments }>) {
  const { name } = props.arguments;
  await executeCapAction("mic", { name });
}
