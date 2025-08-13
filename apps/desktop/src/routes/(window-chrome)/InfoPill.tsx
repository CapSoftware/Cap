import { ComponentProps } from "solid-js";
import { cx } from "cva";

export default function InfoPill(
  props: ComponentProps<"button"> & { variant: "blue" | "red" }
) {
  return (
    <button
      {...props}
      type="button"
      class={cx(
        "px-2 py-0.5 rounded-full text-white text-[11px]",
        props.variant === "blue" ? "bg-blue-9" : "bg-red-9"
      )}
    />
  );
}
