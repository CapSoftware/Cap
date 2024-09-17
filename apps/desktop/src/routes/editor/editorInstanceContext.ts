import { createContextProvider } from "@solid-primitives/context";
import { createResource, createSignal } from "solid-js";

import { events, commands } from "~/utils/tauri";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createPresets } from "~/utils/createPresets";

export const OUTPUT_SIZE = {
  width: 1920,
  height: 1080,
};

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { videoId: string }) => {
    const [currentFrame, setCurrentFrame] = createSignal<ImageData>();

    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance(props.videoId);
      if (instance.status !== "ok") throw new Error("Failed to start editor");

      const ws = new WebSocket(instance.data.framesSocketUrl);
      ws.onopen = () => {
        events.renderFrameEvent.emit({
          frame_number: Math.floor(0),
          project: instance.data.savedProjectConfig ?? DEFAULT_PROJECT_CONFIG,
        });
      };
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        const clamped = new Uint8ClampedArray(event.data);
        const imageData = new ImageData(
          clamped,
          OUTPUT_SIZE.width,
          OUTPUT_SIZE.height
        );
        setCurrentFrame(imageData);
      };

      return instance.data;
    });

    return {
      editorInstance,
      videoId: props.videoId,
      currentFrame,
      presets: createPresets(),
    };
  }, null!);
