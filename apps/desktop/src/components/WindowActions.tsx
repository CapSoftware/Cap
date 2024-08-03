"use client";

import { exit } from "@tauri-apps/plugin-process";
import { Home } from "@/components/icons/Home";
import { openLinkInBrowser } from "@/utils/helpers";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";
  const tauriWindow = import("@tauri-apps/api/window");

  return (
    <div className="w-full flex items-center -mt-3 z-20 absolute top-5">
      <div className="flex flex-grow items-center justify-between px-3">
        <div className="flex space-x-2">
          <div>
            <button
              onClick={async () => {
                if (window.fathom !== undefined) {
                  window.fathom.trackEvent("exit_clicked");
                }
                await exit();
              }}
              className={`bg-red-500 hover:bg-red-700 transition-all ${actionButtonBase}`}
            ></button>
          </div>
          <div>
            <button
              onClick={async () => {
                if (window.fathom !== undefined) {
                  window.fathom.trackEvent("minimize_clicked");
                }
                tauriWindow.then(({ WebviewWindow }) => {
                  const main = WebviewWindow.getByLabel("main");
                  if (main) {
                    main.minimize();
                  }
                });
              }}
              className={`bg-orange-400 hover:bg-orange-500 transition-all ${actionButtonBase}`}
            ></button>
          </div>
          <div>
            <span className={actionButtonBase}></span>
          </div>
        </div>
        <div className="flex">
          <button
            onClick={async () => {
              if (window.fathom !== undefined) {
                window.fathom.trackEvent("home_clicked");
              }
              await openLinkInBrowser(
                `${process.env.NEXT_PUBLIC_URL}/dashboard`
              );
            }}
            className="p-1.5 bg-transparent hover:bg-gray-200 rounded-full transition-all"
          >
            <Home className="w-5 h-5" />
          </button>
          {/* <button className="p-1.5 bg-transparent hover:bg-gray-200 rounded-full transition-all">
            <Settings className="w-5 h-5" />
          </button> */}
        </div>
      </div>
    </div>
  );
};
