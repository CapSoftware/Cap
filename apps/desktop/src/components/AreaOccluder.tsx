import type { Bounds } from "~/utils/tauri";
import { onMount, onCleanup, createEffect, type ParentProps } from "solid-js";
import { createHiDPICanvasContext } from "~/utils/canvas";

function draw(
  ctx: CanvasRenderingContext2D,
  bounds: Bounds,
  radius: number,
  guideLines: boolean
) {
  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Background overlay
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 200;
  ctx.shadowOffsetY = 15;
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.fill();
  ctx.restore();

  // Clear bounds
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.clip();
  ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);

  // Guide lines (Rule of thirds)
  if (guideLines) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
    ctx.lineWidth = 1;

    for (let i = 1; i < 3; i++) {
      const x = bounds.x + (bounds.width * i) / 3;
      const y = bounds.y + (bounds.height * i) / 3;

      ctx.beginPath();
      ctx.moveTo(x, bounds.y);
      ctx.lineTo(x, bounds.y + bounds.height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bounds.x, y);
      ctx.lineTo(bounds.x + bounds.width, y);
      ctx.stroke();
    }

    ctx.stroke();
  }

  ctx.restore();
}

export default function AreaOccluder(
  props: ParentProps<{
    bounds: Bounds;
    guideLines?: boolean;
    borderRadius?: number;
  }>
) {
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvasRef) {
      console.error("Canvas ref was not setup");
      return;
    }

    const hidpiCanvas = createHiDPICanvasContext(canvasRef, (ctx) =>
      draw(
        ctx,
        props.bounds,
        props.borderRadius || 0,
        props.guideLines || false
      )
    );
    const ctx = hidpiCanvas?.ctx;
    if (!ctx) return;

    let lastAnimationFrameId: number | undefined;
    createEffect(() => {
      if (lastAnimationFrameId) cancelAnimationFrame(lastAnimationFrameId);

      const { x, y, width, height } = props.bounds;
      lastAnimationFrameId = requestAnimationFrame(() =>
        draw(
          ctx,
          { x, y, width, height },
          props.borderRadius || 0,
          props.guideLines || false
        )
      );
    });

    onCleanup(() => {
      if (lastAnimationFrameId) cancelAnimationFrame(lastAnimationFrameId);
      hidpiCanvas.cleanup();
    });
  });

  return (
    <div class="*:h-full *:w-full">
      <canvas ref={canvasRef} class="pointer-events-none absolute" />
      <div>{props.children}</div>
    </div>
  );
}
