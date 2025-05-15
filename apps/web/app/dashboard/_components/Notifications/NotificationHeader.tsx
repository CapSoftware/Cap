import { faCheckDouble } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export const NotificationHeader = () => {
  return (
    <div className="flex justify-between items-center px-6 py-3 rounded-t-xl border bg-gray-3 border-gray-4">
      <p className="text-md text-gray-12">Notifications</p>
      <div className="flex gap-1 items-center transition-opacity duration-200 cursor-pointer hover:opacity-70">
        <FontAwesomeIcon
          icon={faCheckDouble}
          className="text-blue-9 size-2.5"
        />
        <p className="text-[13px] text-blue-9">Mark all as read</p>
      </div>
    </div>
  );
};
