import { createContextProvider } from "@solid-primitives/context";
import { createResource, createSignal } from "solid-js";
import { commands } from "../../utils/tauri";

export const OUTPUT_SIZE = {
  width: 1920,
  height: 1080,
};

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { videoId: string }) => {
    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance(props.videoId);
      if (instance.status !== "ok") throw new Error("Failed to start editor");

      const ws = new WebSocket(instance.data.framesSocketUrl);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        const ctx = canvasRef()?.getContext("2d");
        if (!ctx) return;
        const clamped = new Uint8ClampedArray(event.data);
        const imageData = new ImageData(
          clamped,
          OUTPUT_SIZE.width,
          OUTPUT_SIZE.height
        );
        ctx.putImageData(imageData, 0, 0);
      };

      return instance.data;
    });

    const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | null>(
      null
    );

    return { canvasRef, setCanvasRef, editorInstance, videoId: props.videoId };
  }, null!);
