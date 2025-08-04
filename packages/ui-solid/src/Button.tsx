import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";

const styles = cva(
  "outline-offset-2 outline-2 flex justify-center items-center focus-visible:outline rounded-full transition-all will-change-transform duration-200",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        blue: "bg-blue-9 text-white hover:bg-blue-10 disabled:bg-gray-6 disabled:text-gray-9 outline-blue-300 disabled:outline-blue-10",
        primary:
          "bg-gray-12 text-gray-1 hover:bg-gray-11 enabled:hover:bg-blue-8 disabled:bg-gray-6 disabled:text-gray-9 outline-blue-300 disabled:bg-gray-4 disabled:dark:text-gray-9",
        secondary:
          "bg-gray-4 enabled:hover:bg-gray-5 text-gray-500 disabled:bg-gray-6 disabled:text-gray-9 outline-blue-300 disabled:outline-blue-10",
        destructive:
          "bg-red-300 text-gray-50 dark:text-gray-12 disabled:bg-gray-6 disabled:text-gray-9 enabled:hover:bg-red-400 disabled:bg-red-200 outline-red-300",
        white:
          "bg-gray-1 dark:bg-gray-12 enabled:hover:bg-gray-5 text-gray-500 dark:disabled:bg-gray-300 dark:disabled:text-gray-8 dark:text-gray-1 disabled:bg-gray-6 disabled:text-gray-9 outline-blue-300",
        lightdark:
          "bg-gray-12 hover:bg-gray-11 text-gray-1 dark:disabled:bg-gray-300 dark:disabled:text-gray-8 disabled:bg-gray-6 disabled:text-gray-9",
      },
      size: {
        xs: "text-[0.75rem] px-[0.5rem] h-[1.25rem]",
        sm: "text-xs px-[0.75rem] h-[1.75rem]",
        md: "text-[13px] px-3 py-2",
        lg: "text-[0.875rem] px-[1rem] h-[2.25rem]",
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
