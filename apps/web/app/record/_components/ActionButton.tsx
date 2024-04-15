"use client";

import { ReactNode } from "react";

export const ActionButton = ({
  handler,
  icon,
  label,
  width,
  active,
  recordingOption = false,
  optionName,
}: {
  handler?: () => void;
  icon?: ReactNode;
  label?: string;
  width?: string;
  active?: boolean;
  recordingOption?: boolean;
  optionName?: string;
}) => {
  const truncatedLabel =
    label && label.length > 18 ? label.substring(0, 18) + "..." : label;

  const commonProps = {
    className: `${
      active === true
        ? "bg-white hover:bg-gray-100"
        : "bg-gray-200 hover:bg-white"
    } border-gray-300 w-full h-[50px] py-2 px-4 text-[14px] border-2 flex items-center justify-between rounded-[15px] flex-grow transition-all shadow-sm shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)]`,
  };

  const Element = handler ? "button" : "div";

  return (
    <div className="flex-grow">
      <Element {...(handler && { onClick: handler })} {...commonProps}>
        <div className="flex items-center">
          <span>{icon}</span>
          {truncatedLabel && (
            <span
              className={`ml-2 truncate ${width !== "full" && "max-w-[100px]"}`}
            >
              {truncatedLabel === "None" ? `No ${optionName}` : truncatedLabel}
            </span>
          )}
        </div>
        {recordingOption && (
          <div>
            <span
              className={`${
                label === "None"
                  ? "bg-red-600 text-white"
                  : "bg-tertiary text-primary "
              } h-5 w-8 font-medium text-xs rounded-full flex items-center justify-center`}
            >
              <span>{label === "None" ? "Off" : "On"}</span>
            </span>
          </div>
        )}
      </Element>
    </div>
  );
};
