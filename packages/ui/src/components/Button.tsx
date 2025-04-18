import { classNames } from "@cap/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
  "flex items-center justify-center cursor-pointer ring-offset-transparent relative min-w-[100px] button-gradient-border  gap-1 rounded-xl",
  {
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
    variants: {
      variant: {
        primary:
          "bg-gradient-to-t from-blue-300 to-[#75A3FF] shadow-[0_0_0_1px] hover:brightness-110 shadow-blue-400 text-gray-50 hover:bg-blue-400 disabled:bg-blue-200",
        red: "bg-gradient-to-t from-[#772828] to-[#9F3C3C] shadow-[0_0_0_1px] hover:brightness-110 shadow-red-900 text-gray-50 hover:bg-red-400 disabled:bg-red-200",
        secondary:
          "bg-blue-400 text-gray-50 hover:bg-blue-500 disabled:bg-blue-200 disabled:text-gray-400 border-blue-300",
        destructive:
          "bg-red-300 text-gray-50 hover:bg-red-400 disabled:bg-red-200 border-red-300",
        white:
          "bg-gray-50 text-gray-500 hover:bg-gray-100 border disabled:bg-gray-100 border-gray-200",
        gray: "bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:bg-gray-100 border-transparent",
        dark: "bg-gradient-to-t from-[#0f0f0f] to-[#404040] shadow-[0_0_0_1px] hover:brightness-110 shadow-[#383838] text-gray-50 hover:bg-[#383838] disabled:bg-[#383838] border-transparent",
        radialblue:
          "text-gray-50 disabled:bg-gray-100 border-0 [background:radial-gradient(90%_100%_at_15%_12%,#9BC4FF_0%,#3588FF_100%)] border-transparent hover:opacity-80",
      },
      size: {
        xs: "text-[0.75rem] h-[32px] px-[0.5rem] ",
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
