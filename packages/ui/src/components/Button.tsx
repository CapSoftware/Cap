import { classNames } from "@cap/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import clsx from "clsx";
import * as React from "react";

const buttonVariants = cva(
  "flex items-center justify-center not-disabled:cursor-pointer ring-offset-transparent transition-colors duration-200 relative min-w-[100px] gap-1 rounded-xl",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary:
          "bg-gradient-to-t disabled:bg-gradient-to-t button-gradient-border from-blue-10 to-[#75A3FF] shadow-[0_0_0_1px] not-disabled:hover:brightness-110 shadow-blue-11 text-gray-50 hover:bg-blue-9 disabled:from-blue-8 disabled:to-blue-6",
        red: "bg-gradient-to-t button-gradient-border from-[#772828] to-[#9F3C3C] shadow-[0_0_0_1px] hover:brightness-110 shadow-red-900 text-gray-50 hover:bg-red-400 disabled:bg-red-200",
        secondary:
          "bg-blue-400 text-gray-50 hover:bg-blue-500 disabled:bg-blue-200 disabled:text-gray-8 border-blue-300",
        destructive:
          "bg-gradient-to-t disabled:opacity-50 disabled:from-red-800 disabled:to-red-600 disabled:cursor-not-allowed shadow-[0_0_0_1px] shadow-red-900 hover:brightness-110 from-red-600 to-red-400 text-gray-50 button-gradient-border hover:bg-red-400 border-red-300",
        white:
          "bg-gray-2 text-gray-12 hover:border-gray-4 hover:bg-gray-3 border disabled:bg-gray-1 border-gray-3",
        gray: "bg-gray-4 text-gray-12 hover:bg-gray-6 hover:border-gray-7 disabled:bg-gray-1 border-gray-5 border",
        dark: "bg-gray-12 text-gray-1 disabled:cursor-not-allowed hover:bg-gray-11 disabled:text-gray-10 border disabled:bg-gray-7 disabled:border-gray-8 border-gray-12",
        darkgradient:
          "bg-gradient-to-t button-gradient-border from-[#0f0f0f] to-[#404040] shadow-[0_0_0_1px] hover:brightness-110 shadow-[#383838] text-gray-50 hover:bg-[#383838] disabled:bg-[#383838] border-transparent",
        radialblue:
          "text-gray-50 border button-gradient-border shadow-[0_0_0_1px] shadow-blue-400 disabled:bg-gray-1 border-0 [background:radial-gradient(90%_100%_at_15%_12%,#9BC4FF_0%,#3588FF_100%)] border-transparent hover:opacity-80",
      },
      size: {
        xs: "text-xs [var(--gradient-border-radius: 20px)] rounded-lg h-[32px] px-[0.5rem] ",
        sm: "text-sm h-[40px] px-[0.75rem]",
        md: "text-sm px-[1rem] h-[48px]",
        lg: "text-md h-[48px] px-[1.25em]",
      },
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  spinner?: boolean;
  href?: string;
  icon?: React.ReactNode;
  spinnerClass?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      spinner = false,
      spinnerClass,
      href,
      icon,
      ...props
    },
    ref
  ) => {
    const Comp = href ? "a" : asChild ? Slot : ("button" as any);
    return (
      <Comp
        className={classNames(buttonVariants({ variant, size, className }))}
        ref={ref as any}
        href={href || undefined}
        {...props}
      >
        {spinner && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="mr-1 size-5"
            viewBox="0 0 24 24"
          >
            <style>
              {"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
            </style>
            <path
              className="transition-colors duration-200 ease-in-out dark:fill-gray-12 light:fill-gray-1"
              d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
              opacity={0.25}
            />
            <path
              className={clsx(
                "transition-colors duration-200 ease-in-out dark:fill-gray-12 light:fill-gray-1",
                spinnerClass
              )}
              d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
              style={{
                transformOrigin: "center",
                animation: "spinner_AtaB .75s infinite linear",
              }}
            />
          </svg>
        )}
        {icon && icon}
        {props.children}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
