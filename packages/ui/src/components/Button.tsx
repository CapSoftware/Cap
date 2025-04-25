import { classNames } from "@cap/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
  "flex items-center justify-center cursor-pointer ring-offset-transparent relative min-w-[100px]  gap-1 rounded-xl",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary:
          "bg-gradient-to-t button-gradient-border from-blue-8 to-[#75A3FF] shadow-[0_0_0_1px] hover:brightness-110 shadow-blue-4 text-gray-50 hover:bg-blue-9 disabled:bg-blue-200",
        red: "bg-gradient-to-t button-gradient-border from-[#772828] to-[#9F3C3C] shadow-[0_0_0_1px] hover:brightness-110 shadow-red-900 text-gray-50 hover:bg-red-400 disabled:bg-red-200",
        secondary:
          "bg-blue-400 text-gray-50 hover:bg-blue-500 disabled:bg-blue-200 disabled:text-gray-8 border-blue-300",
        destructive:
          "bg-gradient-to-t shadow-[0_0_0_1px] shadow-red-900 hover:brightness-110 from-red-600 to-red-400 text-gray-50 button-gradient-border hover:bg-red-400 disabled:bg-red-200 border-red-300",
        white:
          "bg-gray-12 text-gray-1 hover:bg-gray-11 border disabled:bg-gray-1 border-gray-12",
        gray: "bg-gray-4 text-gray-12 hover:bg-gray-6 hover:border-gray-7 disabled:bg-gray-1 border-gray-5 border",
        normaldark:
          "bg-gray-12 text-gray-1 hover:bg-gray-11 border disabled:bg-gray-1 border-gray-12",
        dark: "bg-gradient-to-t button-gradient-border from-[#0f0f0f] to-[#404040] shadow-[0_0_0_1px] hover:brightness-110 shadow-[#383838] text-gray-50 hover:bg-[#383838] disabled:bg-[#383838] border-transparent",
        radialblue:
          "text-gray-50 border button-gradient-border shadow-[0_0_0_1px] shadow-blue-400 disabled:bg-gray-1 border-0 [background:radial-gradient(90%_100%_at_15%_12%,#9BC4FF_0%,#3588FF_100%)] border-transparent hover:opacity-80",
      },
      size: {
        xs: "text-sm h-[32px] px-[0.5rem] ",
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
            className="mr-2 w-6 h-6"
            viewBox="0 0 24 24"
          >
            <style>
              {"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
            </style>
            <path
              fill={variant === "white" ? "#000" : "#FFF"}
              d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
              opacity={0.25}
            />
            <path
              fill={variant === "white" ? "#000" : "#FFF"}
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
