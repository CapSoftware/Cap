import { createWS } from "@solid-primitives/websocket";
import { createResource } from "solid-js";

export function createImageDataWS(
  url: string,
  onmessage: (data: ImageData) => void
): Omit<WebSocket, "onmessage"> {
  const ws = createWS(url);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (event) => {
    const buffer = event.data as ArrayBuffer;
    const clamped = new Uint8ClampedArray(buffer);

    const widthArr = clamped.slice(clamped.length - 4);
    const heightArr = clamped.slice(clamped.length - 8, clamped.length - 4);

    const width =
      widthArr[0] +
      (widthArr[1] << 8) +
      (widthArr[2] << 16) +
      (widthArr[3] << 24);
    const height =
      heightArr[0] +
      (heightArr[1] << 8) +
      (heightArr[2] << 16) +
      (heightArr[3] << 24);

    const imageData = new ImageData(
      clamped.slice(0, clamped.length - 8),
      width,
      height
    );

    onmessage(imageData);
  };
  return ws;
}

export function createLazySignal<T>() {
  let res: ((value: T) => void) | undefined;

  const [value, { mutate: setValue }] = createResource(
    () =>
      new Promise<T>((r) => {
        res = r;
      })
  );

  return [
    value,
    (value: T) => {
      if (res) {
        res(value);
        res = undefined;
      } else {
        setValue(() => value);
      }
    },
  ] as const;
}
