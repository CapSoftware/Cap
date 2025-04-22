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
          "flex px-4 w-full text-sm font-thin text-gray-500 bg-gray-50 border-gray-200 transition-all duration-300 outline-0 focus:bg-gray-50",
          "rounded-2xl hover:bg-gray-100 h-[48px] placeholder:text-gray-400 py-[14px] border-[1px] focus:border-gray-500",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "disabled:cursor-not-allowed disabled:opacity-50 placeholder:transition-all",
          "ring-0 focus:ring-2 focus:ring-gray-300 focus:ring-offset-2 placeholder:duration-300 hover:placeholder:text-gray-500",
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
