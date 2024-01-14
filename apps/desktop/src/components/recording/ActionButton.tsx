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
          active === true ? "bg-white" : "bg-gray-200"
        } border-gray-300 hover:bg-white w-full h-[50px] py-2 px-4 text-[15px] border-2  flex items-center justify-start rounded-[15px] flex-grow transition-all`}
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
