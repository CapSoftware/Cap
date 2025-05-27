import { classNames } from "@cap/utils";
import React from "react";

const BaseQuantityButtonClasses =
  "flex justify-center items-center px-2 w-6 h-6 rounded-md outline-none";

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
