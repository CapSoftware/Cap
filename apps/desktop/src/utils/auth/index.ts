import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import callbackTemplate from "./callback.template";
import { open } from "@tauri-apps/api/shell";

export const openSignIn = async (port: string) => {
  await open(
    `http://localhost:3000/api/session/verify?redirectUrl=http://localhost:${port}`
  );
};

export const login = () => {
  // Wait for callback from tauri oauth plugin
  listen("oauth://url", (data) => {
    console.log("payload:");
    console.log(data.payload);
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
