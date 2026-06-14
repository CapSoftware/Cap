import { open } from "@raycast/api";

interface Props {
  arguments: {
    camera: string;
  };
}

export default async function Command(props: Props) {
  const value = JSON.stringify({
    SwitchCamera: {
      camera: props.arguments.camera,
    },
  });
  await open(`cap://action?value=${encodeURIComponent(value)}`);
}
