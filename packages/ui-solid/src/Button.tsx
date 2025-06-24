import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";

const styles = cva(
  "rounded-xl outline-offset-2 outline-2 focus-visible:outline transition-all will-change-transform duration-200",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary:
          "bg-blue-9 text-gray-1 dark:text-gray-12 enabled:hover:bg-blue-8 disabled:text-gray-10 outline-blue-300 disabled:bg-gray-4 disabled:dark:text-gray-9",
        secondary:
          "bg-gray-4 enabled:hover:opacity-80 text-gray-500 disabled:bg-gray-3 disabled:text-gray-10 outline-blue-300",
        destructive:
          "bg-red-300 text-gray-50 dark:text-gray-12 dark:disabled:text-gray-10 enabled:hover:bg-red-400 disabled:bg-red-200 outline-red-300",
        white:
          "bg-gray-1 dark:bg-gray-12 enabled:hover:opacity-80 text-gray-500 dark:disabled:bg-gray-300 dark:disabled:text-gray-8 dark:text-gray-1 disabled:bg-gray-400 disabled:text-gray-8 outline-blue-300",
        lightdark:
          "bg-gray-500 enabled:hover:opacity-80 text-gray-100 dark:disabled:bg-gray-300 dark:disabled:text-gray-8 dark:text-gray-1 disabled:bg-gray-400 disabled:text-gray-8 outline-blue-300",
      },
      size: {
        xs: "font-[400] text-[0.75rem] px-[0.5rem] h-[1.25rem] ",
        sm: "font-[400] text-[0.875rem] px-[0.75rem] h-[1.75rem]",
        md: "font-[400] text-sm px-4 py-2.5",
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
