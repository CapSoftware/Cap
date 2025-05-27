import { classNames } from "@cap/utils";
import React from "react";

const BaseQuantityButtonClasses =
  "flex justify-center items-center px-2 py-0 w-6 h-6 rounded-md focus:outline-none focus:ring-2 focus:ring-gray-400";

export const QuantityButton = ({
  onClick,
  children,
  className,
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <button
      onClick={onClick}
      className={classNames(BaseQuantityButtonClasses, className)}
    >
      {children}
    </button>
  );
};
