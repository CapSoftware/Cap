import { ReactNode } from "react";

export const ActionButton = ({
  handler,
  icon,
  label,
}: {
  handler: () => void;
  icon?: ReactNode;
  label?: string;
}) => {
  return (
    <div>
      <button
        onClick={handler}
        className="w-full h-[50px] py-2 px-4 bg-gray-100 hover:bg-white text-[15px] border-2 border-gray-300 flex items-center justify-start rounded-[15px] transition-all "
      >
        <span>{icon}</span>
        {label && <span className="ml-2">{label}</span>}
      </button>
    </div>
  );
};
