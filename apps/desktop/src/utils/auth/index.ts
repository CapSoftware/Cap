import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import callbackTemplate from "./callback.template";
import { open } from "@tauri-apps/api/shell";
import { parse } from "url";

export const openSignIn = async (port: string) => {
  await open(
    `http://localhost:3000/api/session/request?redirectUrl=http://localhost:${port}`
  );
};

export const login = () => {
  // Wait for callback from tauri oauth plugin
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

  // Start tauri oauth plugin. When receive first request
  // When it starts, will return the server port
  // it will kill the server
  invoke("plugin:oauth|start", {
    config: {
      // Optional config, but use here to more friendly callback page
      response: callbackTemplate,
    },
  }).then((port) => {
    openSignIn(port as string);
  });
};
