import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";

const styles = cva("rounded-full outline-offset-1 outline-1", {
  defaultVariants: {
    variant: "primary",
    size: "md",
  },
  variants: {
    variant: {
      primary:
        "bg-blue-300 text-gray-50 hover:bg-blue-400 disabled:bg-blue-200 focus-visible:outline outline-blue-300",
      secondary:
        "bg-gray-200 text-gray-500 hover:bg-gray-300 disabled:bg-gray-200 disabled:text-gray-400 focus-visible:outline outline-blue-300",
      destructive:
        "bg-red-300 text-gray-50 hover:bg-red-400 disabled:bg-red-200 focus-visible:outline outline-red-300",
    },
    size: {
      xs: "font-[500] text-[0.75rem] px-[0.5rem] h-[1.25rem] ",
      sm: "font-[500] text-[0.875rem] px-[0.75rem] h-[1.75rem]",
      md: "font-[500] text-[0.875rem] px-[1rem] h-[2rem]",
      lg: "font-[500] text-[0.875rem] px-[1rem] h-[2.25rem]",
    },
  },
});

export function Button(
  props: VariantProps<typeof styles> & ComponentProps<"button">
) {
  return (
    <button
      {...props}
      type="button"
      class={styles({ ...props, class: props.class })}
    />
  );
}
