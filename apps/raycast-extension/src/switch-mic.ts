import { executeCapAction } from "./utils";

export default async function Command(props: { arguments: { mic_label: string } }) {
  await executeCapAction({
    switch_mic: {
      mic_label: props.arguments.mic_label,
    },
  });
}
