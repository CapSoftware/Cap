import { Tooltip as KTooltip } from "@kobalte/core";
import { cx } from "cva";
import { ComponentProps, JSX } from "solid-js";

interface Props extends ComponentProps<typeof KTooltip.Root> {
  content: JSX.Element;
  childClass?: string;
}

export default function Tooltip(props: Props) {
  return (
    <KTooltip.Root {...props} openDelay={props.openDelay ?? 200}>
      <KTooltip.Trigger class={cx(props.childClass)}>
        {props.children}
      </KTooltip.Trigger>
      <KTooltip.Portal>
        <KTooltip.Content class="z-50 px-1.5 py-1 text-xs border border-gray-3 bg-gray-12 text-gray-1 rounded shadow-lg duration-100 animate-in fade-in slide-in-from-top-1 min-w-6 text-center">
          {props.content}
          <KTooltip.Arrow size={16} />
        </KTooltip.Content>
      </KTooltip.Portal>
    </KTooltip.Root>
  );
}
