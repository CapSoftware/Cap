import { Tooltip as CapTooltip } from "@kobalte/core";
import { TooltipRootProps } from "@kobalte/core/tooltip";
import { cx } from "cva";
import { JSX } from "solid-js";

interface Props {
  children: JSX.Element;
  content: JSX.Element;
  placement?: TooltipRootProps["placement"];
  childClass?: string;
}

export default function Tooltip(props: Props) {
  return (
    <CapTooltip.Root placement={props.placement} openDelay={500}>
      <CapTooltip.Trigger class={cx(props.childClass)}>
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
