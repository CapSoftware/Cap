"use client";

import { Home } from "@/components/icons/Home";
import { openLinkInBrowser } from "@/utils/helpers";
import { Globe } from "./icons/Globe";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import { Email } from "./icons/Email";
import { Bot } from "./icons/Bot";
import { RotateCCW } from "./icons/RotateCCW";
import toast from "react-hot-toast";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";
  const tauriWindow = import("@tauri-apps/api/window");
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "failed" | "pending"
  >("pending");
  const [lastConnectionInfo, setLastConnectionInfo] = useState<{
    connected: boolean;
    latency: string;
    status: number;
    message: string;
  } | null>();
  const [lastConnectionError, setLastConnectionError] = useState<{
    type: "timeout" | "abort";
    message: string | null;
  } | null>(null);

  const checkStatus = async (showPendingStatus = true) => {
    if (showPendingStatus) {
      setConnectionStatus("pending");
      setLastConnectionError(null);
      setLastConnectionInfo(null);
    }

    const startTime = performance.now();

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_URL}/api/status?origin=${window.location.origin}`,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        }
      );

      const endTime = performance.now();
      const latency = endTime - startTime;

      if (response.ok) {
        const data = await response.text();
        setConnectionStatus("connected");
        setLastConnectionInfo({
          connected: true,
          latency: latency.toFixed(0),
          status: response.status,
          message: data,
        });
        setLastConnectionError(null);
      } else {
        setConnectionStatus("failed");
        setLastConnectionInfo(null);
        setLastConnectionError({ type: "abort", message: response.statusText });
      }
    } catch (error) {
      setConnectionStatus("failed");
      setLastConnectionInfo(null);

      switch (error.name) {
        case "TimeoutError": {
          setLastConnectionError(error.message);
        }
        case "AbortError": {
        }
        default: {
          console.error("Failed to check connection status", error);
        }
      }
    }
  };

  useEffect(() => {
    checkStatus(false);

    let timeout: NodeJS.Timeout = null;
    timeout = setInterval(() => {
      if (document.hasFocus()) checkStatus();
    }, 20000);

    return () => {
      if (timeout) clearInterval(timeout);
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
    <div className="w-full flex items-center -mt-3 z-50 absolute top-5">
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
              className="bg-white w-64 shadow-2xl bg-opacity-80 backdrop-blur-md"
              style={{ marginRight: "18px" }}
            >
              <div className="flex flex-col">
                <div className="font-bold border-b pb-1 mb-2 flex justify-between items-center">
                  <div>
                    {connectionStatus === "pending" && (
                      <p>Cap is connecting...</p>
                    )}
                    {connectionStatus === "failed" && <p>Failed to connect!</p>}
                    {connectionStatus === "connected" && <p>Cap is online!</p>}
                  </div>
                  <button
                    onClick={() => {
                      if (connectionStatus !== "pending") checkStatus();
                    }}
                    disabled={connectionStatus === "pending"}
                    className={`flex items-center justify-center p-1 text-sm font-medium rounded-md bg-white disabled:bg-gray-100 disabled:opacity-50 bg-opacity-80 text-gray-900 hover:bg-gray-100 border border-gray-200 transition-all duration-200 active:scale-90`}
                    aria-label="Refresh connection"
                  >
                    <RotateCCW className="w-3 h-3 " />
                  </button>
                </div>
                {process.env.NODE_ENV === "development" && (
                  <div className="bg-gray-100 rounded-md mb-3 text-sm p-1 !outline-2 !outline-dashed !outline-yellow-500 text-balance">
                    <p className="font-medium mb-2">Running in development?</p>
                    <p className="mb-2">
                      Current server is set to:{" "}
                      <code className="bg-white rounded-sm px-1">
                        {process.env.NEXT_PUBLIC_URL}
                      </code>
                    </p>
                    <p>
                      If you're only running the desktop app, you can set{" "}
                      <code className="bg-white rounded-sm px-1">
                        NEXT_PUBLIC_URL
                      </code>{" "}
                      to{" "}
                      <code className="bg-white rounded-sm px-1">
                        https://cap.so
                      </code>
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-sm mb-1">Need support?</p>
                  <div className="flex space-x-1 h-8">
                    <button
                      type="button"
                      className="flex items-center justify-center w-full text-sm font-medium rounded-md bg-white bg-opacity-80 text-gray-900 hover:bg-gray-100 border border-gray-200 transition-all duration-200 active:scale-95"
                      onClick={() => {
                        const mail = process.env.CAP_SUPPORT_EMAIL_ADDRESS;
                        if (mail) openLinkInBrowser(`mailto:${mail}`);
                        else if (process.env.NODE_ENV === "development") {
                          toast.error(
                            "Support Email is not set. Check console."
                          );
                          console.error(
                            "Make sure to set the value for `CAP_SUPPORT_EMAIL_ADDRESS` in env"
                          );
                        }
                      }}
                    >
                      <Email className="w-4 h-4 mr-2" />
                      Email
                    </button>
                    <button
                      type="button"
                      className={`flex items-center justify-center w-full text-sm font-medium rounded-md bg-white bg-opacity-80 text-gray-900 hover:bg-gray-100 border border-gray-200 transition-all duration-200 active:scale-95`}
                      onClick={() => {
                        const url = process.env.CAP_SUPPORT_DISCORD_URL;
                        if (url) openLinkInBrowser(url);
                        else if (process.env.NODE_ENV === "development") {
                          toast.error(
                            "Support Discord Server is not set. Check console."
                          );
                          console.error(
                            "Make sure to set the value for `CAP_SUPPORT_DISCORD_URL` in env"
                          );
                        }
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
                    className="text-xs font-medium text-gray-800 hover:underline duration-200 transition-all active:scale-95"
                    onClick={() =>
                      openLinkInBrowser("https://cap.openstatus.dev/")
                    }
                  >
                    Cap System Status
                  </button>
                  <div className="text-sm text-gray-600">
                    <small>
                      <code>
                        {connectionStatus === "connected" &&
                          `${lastConnectionInfo?.latency}ms`}
                        {connectionStatus === "pending" && "Pending..."}
                        {connectionStatus === "failed" &&
                          (lastConnectionError?.type === "timeout"
                            ? "Timed out."
                            : "No connection.")}
                      </code>
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
