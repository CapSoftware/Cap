import * as React from "react";

import { classNames } from "@cap/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={classNames(
          "flex px-4 w-full text-sm font-thin transition-all duration-200 text-gray-12 bg-gray-1 border-gray-3 outline-0 focus:bg-gray-2",
          "rounded-xl hover:bg-gray-1 h-[48px] placeholder:text-gray-8 py-[14px] border-[1px] focus:border-gray-4",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "disabled:cursor-not-allowed disabled:opacity-50 placeholder:transition-all",
          "ring-0 ring-gray-3 focus:ring-2 focus:ring-gray-3 focus:ring-offset-2 ring-offset-gray-1 placeholder:duration-200 hover:placeholder:text-gray-12",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
