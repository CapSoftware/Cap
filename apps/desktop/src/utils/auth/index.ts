import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import callbackTemplate from "./callback.template";
import { open } from "@tauri-apps/api/shell";
import { parse } from "url";

export const openSignIn = async (port: string) => {
  await open(
    `${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?redirectUrl=http://localhost:${port}`
  );
};

export const login = () => {
  listen("oauth://url", (data: { payload: string }) => {
    if (!data.payload.includes("token")) {
      return;
    }

    const urlObject = parse(data.payload, true);

    const token = urlObject.query.token as string;
    const expires = urlObject.query.expires as string;

    if (!token || !expires) {
      return;
    }

    const expiresDate = new Date(parseInt(expires) * 1000);

    document.cookie = `next-auth.session-token=${token}; expires=${expiresDate.toUTCString()}; path=/`;
  });

  invoke("plugin:oauth|start", {
    config: {
      response: callbackTemplate,
    },
  }).then((port) => {
    openSignIn(port as string);
  });
};
