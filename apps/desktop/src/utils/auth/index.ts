"use client";

import callbackTemplate from "./callback.template";

const dynamicImports = {
  invoke: () => import("@tauri-apps/api/core").then(({ invoke }) => invoke),
  listen: () => import("@tauri-apps/api/event").then(({ listen }) => listen),
  shell: () => import("@tauri-apps/plugin-shell"),
};

export const openSignIn = async (port: string) => {
  if (typeof window !== "undefined" && typeof navigator !== "undefined") {
    const { open } = await dynamicImports.shell();
    await open(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?port=${port}`
    );
  }
};

export const login = () => {
  if (typeof window !== "undefined" && typeof navigator !== "undefined") {
    console.log("login here");

    dynamicImports
      .listen()
      .then((listen) => {
        listen("oauth://url", async (data: { payload: string }) => {
          console.log("oauth://url", data.payload);

          if (!data.payload.includes("token")) {
            return;
          }

          const urlObject = new URL(data.payload);

          const token = urlObject.searchParams.get("token");
          const expires = urlObject.searchParams.get("expires");

          if (!token || !expires) {
            console.error("Missing token or expires");
            return;
          }

          try {
            localStorage.setItem(
              "session",
              JSON.stringify({ token: token, expires: expires })
            );
            if (window.fathom !== undefined) {
              window.fathom.trackEvent("signin_success");
            }
            console.log("Setting localstorage");
          } catch (error) {
            console.error("Error setting item in localStorage", error);
          }
        });
      })
      .catch((error) => {
        console.error("Error listening for oauth://url", error);
      });

    dynamicImports
      .invoke()
      .then((invoke) => {
        invoke("plugin:oauth|start", {
          config: {
            response: callbackTemplate,
          },
        })
          .then(async (port) => {
            await openSignIn(port as string);
          })
          .catch((error) => {
            console.error("Error invoking oauth plugin", error);
          });
      })
      .catch((error) => {
        console.error("Error 2 invoking oauth plugin", error);
      });
  }
};
