import { classNames } from "@cap/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
  "flex items-center justify-center rounded-full disabled:cursor-not-allowed cursor-pointer font-medium px-[1.25rem] ring-offset-transparent relative gap-1",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary: "bg-gray-12 text-gray-1 hover:bg-gray-11 disabled:bg-gray-6 disabled:text-gray-9",
        blue: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-200 disabled:text-gray-8",
        destructive:
          "bg-red-500 text-white hover:bg-red-600 disabled:bg-red-200",
        outline: "border border-gray-8 text-gray-12 hover:bg-gray-2 disabled:bg-gray-8",
        white: "bg-gray-1 text-gray-12 hover:bg-gray-2 disabled:bg-gray-8",
        ghost: "hover:bg-white/20 hover:text-white",
        gray: "bg-gray-4 text-gray-12 hover:bg-gray-5 disabled:bg-gray-6 disabled:text-gray-9",
        dark: "bg-gray-12 text-gray-1 disabled:cursor-not-allowed hover:bg-gray-11 disabled:text-gray-10 disabled:bg-gray-7 disabled:border-gray-8",
        darkgradient:
          "bg-gradient-to-t button-gradient-border from-[#0f0f0f] to-[#404040] shadow-[0_0_0_1px] hover:brightness-110 shadow-[#383838] text-gray-50 hover:bg-[#383838] disabled:bg-[#383838] border-transparent",
        radialblue:
          "text-gray-50 border button-gradient-border shadow-[0_0_0_1px] shadow-blue-400 disabled:bg-gray-1 border-0 [background:radial-gradient(90%_100%_at_15%_12%,#9BC4FF_0%,#3588FF_100%)] border-transparent hover:opacity-80",
      },
      size: {
        xs: "text-xs h-[32px]",
        sm: "text-sm h-[40px]",
        md: "text-sm h-[44px]",
        lg: "text-md h-[48px]",
        icon: "h-9 w-9",
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      spinner = false,
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
              className="dark:fill-gray-12 light:fill-gray-1"
              d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
              opacity={0.25}
            />
            <path
              className="dark:fill-gray-12 light:fill-gray-1"
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
