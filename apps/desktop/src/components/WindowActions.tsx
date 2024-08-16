"use client";

import { Home } from "@/components/icons/Home";
import { openLinkInBrowser } from "@/utils/helpers";
import { Globe } from "./icons/Globe";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import { Email } from "./icons/Email";
import { Bot } from "./icons/Bot";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";
  const tauriWindow = import("@tauri-apps/api/window");
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "failed" | "pending"
  >("pending");

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    // Simulating a connection check
    const checkConnection = () => {
      // Replace this with your actual connection check logic
      timeout = setInterval(() => {
        const rand = Math.random();
        setConnectionStatus(
          rand > 0.6 ? "connected" : rand > 0.3 ? "pending" : "failed"
        );
      }, 10000);
    };

    checkConnection();

    return () => {
      clearInterval(timeout);
    };
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
              className="bg-white w-64 shadow-xl bg-opacity-80 backdrop-blur-md"
              style={{ marginRight: "18px" }}
            >
              <div className="flex flex-col">
                <div className="font-bold border-b pb-1 mb-2">
                  {connectionStatus === "pending" && (
                    <p>Cap is connecting...</p>
                  )}
                  {connectionStatus === "failed" && <p>Failed to connect!</p>}
                  {connectionStatus === "connected" && <p>Cap is online!</p>}
                </div>
                <div>
                  <p className="text-sm mb-1">Need support?</p>
                  <div className="flex space-x-1 h-8">
                    <button
                      type="button"
                      className="flex items-center justify-center w-full text-sm font-medium rounded-md bg-white bg-opacity-80 text-gray-900 hover:bg-gray-100 border border-gray-200 transition-colors duration-200"
                      onClick={() => openLinkInBrowser("mailto:hello@cap.so")}
                    >
                      <Email className="w-4 h-4 mr-2" />
                      Email
                    </button>
                    <button
                      type="button"
                      className={`flex items-center justify-center w-full text-sm font-medium rounded-md bg-white bg-opacity-80 text-gray-900 hover:bg-gray-100 border border-gray-200 transition-colors duration-200`}
                      onClick={() => {
                        const url = process.env.CAP_DISCORD_SUPPORT_URL;
                        if (url) openLinkInBrowser(url);
                      }}
                    >
                      <Bot className="w-4 h-4 mr-2" />
                      Discord
                    </button>
                  </div>
                </div>
                <div className="flex mt-4 w-full justify-between items-center">
                  <button
                    type="button"
                    className="text-xs font-medium text-gray-800 hover:underline transition-colors duration-200"
                    onClick={() =>
                      openLinkInBrowser("https://cap.openstatus.dev/")
                    }
                  >
                    Cap System Status
                  </button>
                  <div className="text-sm text-gray-600">
                    <small>
                      <code>Latency: 0ms</code>
                    </small>
                  </div>
                </div>
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
