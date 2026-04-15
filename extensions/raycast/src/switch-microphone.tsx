import { open } from "@raycast/api";

interface Props {
  arguments: {
    mic: string;
  };
}

export default async function Command(props: Props) {
  const value = JSON.stringify({
    SwitchMicrophone: {
      mic_label: props.arguments.mic,
    },
  });
  await open(`cap://action?value=${encodeURIComponent(value)}`);
}
