import { ReactNode } from "react";

export const ActionButton = ({
  handler,
  icon,
  label,
  width,
  active,
}: {
  handler: () => void;
  icon?: ReactNode;
  label?: string;
  width?: string;
  active?: boolean;
}) => {
  return (
    <div className="flex-grow">
      <button
        onClick={handler}
        className={`${
          active === true
            ? "bg-white hover:bg-gray-100"
            : "bg-gray-100 hover:bg-white"
        } border-gray-300 w-full h-[50px] py-2 px-4 text-[15px] border-2  flex items-center justify-start rounded-[15px] flex-grow transition-all shadow-sm shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)]`}
      >
        <span>{icon}</span>
        {label && (
          <span
            className={`ml-2 truncate ${width !== "full" && "max-w-[100px]"}`}
          >
            {label}
          </span>
        )}
      </button>
    </div>
  );
};
