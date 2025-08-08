import {
  faArrowUp,
  faBellSlash,
  faCheck,
  faCog,
  faComment,
  faEye,
  faReply,
  faThumbsUp,
  IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Menu, Transition } from "@headlessui/react";
import clsx from "clsx";
import { Fragment, useState } from "react";
import { updatePreferences } from "@/actions/notifications/update-preferences";
import { toast } from "sonner";
import { useDashboardContext } from "../../Contexts";

type NotificationOption = {
  icon: IconDefinition;
  label: string;
  value: "pauseComments" | "pauseViews" | "pauseReactions" | "pauseReplies";
};

const notificationOptions: NotificationOption[] = [
  { icon: faComment, label: "Comments", value: "pauseComments" },
  { icon: faReply, label: "Replies", value: "pauseReplies" },
  { icon: faEye, label: "Views", value: "pauseViews" },
  { icon: faThumbsUp, label: "Reactions", value: "pauseReactions" },
];

export const SettingsDropdown = () => {
  const [showPauseSubmenu, setShowPauseSubmenu] = useState(false);
  const { userPreferences } = useDashboardContext();

  const updateNotificationPreferences = async (option: NotificationOption) => {
    try {
      const currentPrefs = userPreferences?.notifications ?? {
        pauseComments: false,
        pauseReplies: false,
        pauseViews: false,
        pauseReactions: false,
      };

      await updatePreferences({
        notifications: {
          ...currentPrefs,
          [option.value]: !(currentPrefs[option.value] ?? false),
        },
      });

      toast.success(
        `Notifications from ${option.label} have been ${
          !(currentPrefs[option.value] ?? false) ? "paused" : "unpaused"
        }`
      );
    } catch (error) {
      console.error("Failed to update preferences:", error);
      toast.error("Failed to update notification preferences");
    }
  };

  return (
    <Menu as="div" className="relative">
      <Menu.Button className="flex gap-1 items-center transition-opacity duration-200 cursor-pointer hover:opacity-70">
        <FontAwesomeIcon icon={faCog} className="text-gray-10 size-3" />
        <p className="text-[13px] text-gray-10">Settings</p>
      </Menu.Button>

      <Transition
        as={Fragment}
        enter="transition ease-out duration-200"
        enterFrom="opacity-0 scale-95"
        enterTo="opacity-100 scale-100"
        leave="transition ease-in duration-150"
        leaveFrom="opacity-100 scale-100"
        leaveTo="opacity-0 scale-95"
      >
        <Menu.Items className="absolute right-0 top-4 mb-2 min-w-[200px] bg-gray-2 rounded-lg shadow-lg border border-gray-3 p-1.5 z-50 focus:outline-none">
          <div className="relative">
            <Menu.Item>
              {({ active }) => (
                <div
                  className={clsx(
                    "flex flex-1 items-center group justify-between px-2 py-1 min-w-fit text-[13px] text-gray-11 rounded-lg cursor-pointer outline-none",
                    active || showPauseSubmenu ? "bg-gray-3" : ""
                  )}
                  onMouseEnter={() => setShowPauseSubmenu(true)}
                  onMouseLeave={() => setShowPauseSubmenu(false)}
                >
                  <div className="flex gap-2 items-center">
                    <FontAwesomeIcon
                      icon={faBellSlash}
                      className="text-gray-10 text-[13px] size-3.5 transition-colors group-hover:text-gray-12"
                    />
                    <p className="text-[13px] transition-colors group-hover:text-gray-12">
                      Pause notifications
                    </p>
                  </div>
                  <FontAwesomeIcon
                    icon={faArrowUp}
                    className="text-gray-10 size-2.5 rotate-90 transition-colors group-hover:text-gray-12"
                  />
                </div>
              )}
            </Menu.Item>

            {/* Submenu */}
            {showPauseSubmenu && (
              <div
                className="absolute top-0 left-full z-50 p-2 -ml-1 rounded-lg border shadow-lg min-w-[150px] bg-gray-2 border-gray-3"
                onMouseEnter={() => setShowPauseSubmenu(true)}
                onMouseLeave={() => setShowPauseSubmenu(false)}
              >
                {notificationOptions.map((option, index) => (
                  <div
                    key={index}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1 text-[13px] text-gray-11 rounded-lg group hover:bg-gray-3 cursor-pointer outline-none"
                    onClick={async () =>
                      await updateNotificationPreferences(option)
                    }
                  >
                    <div className="flex gap-1.5 items-center">
                      <FontAwesomeIcon
                        icon={option.icon}
                        className="text-gray-10 size-3.5 transition-colors group-hover:text-gray-12"
                      />
                      <p className="text-[13px] transition-colors group-hover:text-gray-12">
                        {option.label}
                      </p>
                    </div>

                    {userPreferences?.notifications[option.value] && (
                      <FontAwesomeIcon
                        icon={faCheck}
                        className="text-gray-10 size-2.5 transition-colors group-hover:text-gray-12"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Menu.Items>
      </Transition>
    </Menu>
  );
};

export default SettingsDropdown;
