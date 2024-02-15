"use client";

import callbackTemplate from "./callback.template";

const dynamicImports = {
  invoke: () => import("@tauri-apps/api").then(({ invoke }) => invoke),
  listen: () => import("@tauri-apps/api/event").then(({ listen }) => listen),
  shell: () => import("@tauri-apps/api/shell"),
};

export const openSignIn = async (port: string) => {
  if (typeof window !== "undefined" && typeof navigator !== "undefined") {
    const { open } = await dynamicImports.shell(); // Correctly accessing the shell module
    await open(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?redirectUrl=http://localhost:${port}`
    );
  }
};

export const login = () => {
  if (typeof window !== "undefined" && typeof navigator !== "undefined") {
    dynamicImports.listen().then((listen) => {
      listen("oauth://url", async (data: { payload: string }) => {
        if (!data.payload.includes("token")) {
          return;
        }

        // Direct use of the URL global object
        const urlObject = new URL(data.payload);

        const token = urlObject.searchParams.get("token");
        const expires = urlObject.searchParams.get("expires");

        if (!token || !expires) {
          return;
        }

        const expiresDate = new Date(parseInt(expires) * 1000);

        if (typeof document !== "undefined") {
          document.cookie = `next-auth.session-token=${token}; expires=${expiresDate.toUTCString()}; path=/`;
        }
      });
    });

    dynamicImports.invoke().then((invoke) => {
      invoke("plugin:oauth|start", {
        config: {
          response: callbackTemplate,
        },
      }).then(async (port) => {
        await openSignIn(port as string);
      });
    });
  }
};
