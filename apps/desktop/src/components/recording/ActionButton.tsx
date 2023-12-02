import { ReactNode } from "react";

export const ActionButton = ({
  handler,
  icon,
  label,
  width,
}: {
  handler: () => void;
  icon?: ReactNode;
  label?: string;
  width?: string;
}) => {
  return (
    <div className="flex-grow">
      <button
        onClick={handler}
        className="w-full h-[50px] py-2 px-4 bg-gray-100 hover:bg-white text-[15px] border-2 border-gray-300 flex items-center justify-start rounded-[15px] flex-grow transition-all"
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
