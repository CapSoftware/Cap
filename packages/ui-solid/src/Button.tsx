import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";

const styles = cva(
  "rounded-full outline-offset-2 outline-2 focus-visible:outline",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary:
          "bg-blue-300 text-gray-50 dark:text-gray-500 hover:bg-blue-400 disabled:bg-blue-200 outline-blue-300",
        secondary:
          "bg-gray-200 text-gray-500 hover:bg-gray-300 disabled:bg-gray-200 disabled:text-gray-400 outline-blue-300",
        destructive:
          "bg-red-300 text-gray-50 dark:text-gray-500 hover:bg-red-400 disabled:bg-red-200 outline-red-300",
        white:
          "bg-gray-50 dark:bg-gray-500 text-gray-500 dark:text-gray-50 hover:bg-gray-100 disabled:bg-gray-50 disabled:text-gray-400 outline-blue-300",
      },
      size: {
        xs: "font-[400] text-[0.75rem] px-[0.5rem] h-[1.25rem] ",
        sm: "font-[400] text-[0.875rem] px-[0.75rem] h-[1.75rem]",
        md: "font-[400] text-[0.875rem] px-[1rem] h-[2rem]",
        lg: "font-[400] text-[0.875rem] px-[1rem] h-[2.25rem]",
      },
    },
  }
);

export function Button(
  props: VariantProps<typeof styles> & ComponentProps<"button">
) {
  return (
    <button
      type="button"
      {...props}
      class={styles({ ...props, class: props.class })}
    />
  );
}
