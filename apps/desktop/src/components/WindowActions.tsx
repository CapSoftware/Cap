"use client";

import { Home } from "@/components/icons/Home";
import { openLinkInBrowser } from "@/utils/helpers";
import { Globe } from "./icons/Globe";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@cap/ui";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";
  const tauriWindow = import("@tauri-apps/api/window");
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "failed" | "pending"
  >("pending");

  useEffect(() => {
    // Simulating a connection check
    const checkConnection = () => {
      // Replace this with your actual connection check logic
      setInterval(() => {
        const rand = Math.random();
        setConnectionStatus(
          rand > 0.6 ? "connected" : rand > 0.3 ? "pending" : "failed"
        );
      }, 10000);
    };

    checkConnection();
  }, []);

  const getConnectionStatusColor = () => {
    switch (connectionStatus) {
      case "connected":
        return "bg-green-400";
      case "failed":
        return "bg-red-500";
      default:
        return "bg-yellow-400";
    }
  };

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
                tauriWindow.then(({ getCurrentWindow }) => {
                  getCurrentWindow().hide();
                });
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
                tauriWindow.then(({ getCurrentWindow }) => {
                  getCurrentWindow().minimize();
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
          <Popover>
            <PopoverTrigger>
              <div className="p-1.5 bg-transparent hover:bg-gray-200 rounded-full transition-all group">
                <div className="relative">
                  <Globe className="w-5 h-5" />
                  <span
                    className={`${getConnectionStatusColor()} absolute bottom-0.5 left-3 transform translate-y-1/4 w-3 h-3 border-2 border-white group-hover:border-gray-200 rounded-full`}
                  ></span>
                </div>
              </div>
            </PopoverTrigger>
            <PopoverContent
              align="center"
              side="bottom"
              className="bg-white w-64"
              style={{ marginRight: "18px" }}
            >
              <div>
                <span className="font-extra-bold">this is a demo</span>
                <br />
                <small>
                  <code>Connection: {connectionStatus}</code>
                </small>
                <br />
                Cap is connected
                <br />
                <span>Latency: 0ms</span>
                <br />
                {"<support links>"}
              </div>
            </PopoverContent>
          </Popover>
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
