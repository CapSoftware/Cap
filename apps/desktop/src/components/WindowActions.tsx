import { exit } from "@tauri-apps/api/process";
import { Home } from "@/components/icons/Home";
import { Settings } from "@/components/icons/Settings";
import { openLinkInBrowser } from "@/utils/helpers";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";

  return (
    <div className="w-full flex items-center -mt-3 z-20 absolute top-5">
      <div className="flex flex-grow items-center justify-between px-3">
        <div className="flex space-x-2">
          <div>
            <button
              onClick={async () => {
                await exit();
              }}
              className={`bg-red-500 hover:bg-red-700 transition-all ${actionButtonBase}`}
            ></button>
          </div>
          <div>
            <span className={actionButtonBase}></span>
          </div>
          <div>
            <span className={actionButtonBase}></span>
          </div>
        </div>
        <div className="flex">
          <button
            onClick={async () => {
              await openLinkInBrowser(
                `${process.env.NEXT_PUBLIC_URL}/dashboard`
              );
            }}
            className="p-1.5 bg-transparent hover:bg-gray-200 rounded-full transition-all"
          >
            <Home className="w-5 h-5" />
          </button>
          <button className="p-1.5 bg-transparent hover:bg-gray-200 rounded-full transition-all">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
