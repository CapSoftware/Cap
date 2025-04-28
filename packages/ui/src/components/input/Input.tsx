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
          "flex px-4 w-full text-sm font-thin transition-all duration-200 text-gray-12 bg-gray-3 border-gray-4 outline-0 focus:bg-gray-3",
          "rounded-xl hover:bg-gray-4 hover:border-gray-5 h-[48px] placeholder:text-gray-8 py-[14px] border-[1px] focus:border-gray-5",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "disabled:cursor-not-allowed disabled:bg-gray-1 disabled:bg-gray-2 disabled:text-gray-9 placeholder:transition-all",
          "ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-1 placeholder:text-gray-12 placeholder:duration-200",
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
