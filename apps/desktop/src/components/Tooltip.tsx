import { Tooltip as CapTooltip } from "@kobalte/core";
import { JSX } from "solid-js";

interface Props {
  children: JSX.Element;
  content: JSX.Element;
}

export default function Tooltip(props: Props) {
  return (
    <CapTooltip.Root openDelay={500}>
      <CapTooltip.Trigger class="flex fixed flex-row items-center w-8 h-8">
        {props.children}
      </CapTooltip.Trigger>
      <CapTooltip.Portal>
        <CapTooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg duration-100 animate-in fade-in">
          {props.content}
          <CapTooltip.Arrow class="fill-gray-500" />
        </CapTooltip.Content>
      </CapTooltip.Portal>
    </CapTooltip.Root>
  );
}
