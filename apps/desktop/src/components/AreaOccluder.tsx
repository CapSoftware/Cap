import type { Bounds } from "~/utils/tauri";
import {
  onMount,
  onCleanup,
  createEffect,
  type ParentProps,
  createSignal,
} from "solid-js";
import { createHiDPICanvasContext } from "~/utils/canvas";

function draw(
  ctx: CanvasRenderingContext2D,
  bounds: Bounds,
  radius: number,
  guideLines: boolean,
  showHandles: boolean,
  prefersDark: boolean
) {
  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Background overlay
  ctx.fillStyle = prefersDark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
  ctx.shadowBlur = 200;
  ctx.shadowOffsetY = 25;
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.fill();
  ctx.restore();

  if (showHandles) {
    ctx.strokeStyle = "rgba(255, 255, 255, 1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
    ctx.stroke();

    const cornerHandleDistance = radius;
    const sideHandleDistance = 0;
    const handleLength = 20;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    // Top-left corner
    ctx.beginPath();
    ctx.arc(
      bounds.x + radius,
      bounds.y + radius,
      cornerHandleDistance,
      Math.PI,
      (Math.PI * 3) / 2
    );
    ctx.stroke();

    // Top-right corner
    ctx.beginPath();
    ctx.arc(
      bounds.x + bounds.width - radius,
      bounds.y + radius,
      cornerHandleDistance,
      (Math.PI * 3) / 2,
      0
    );
    ctx.stroke();

    // Bottom-left corner
    ctx.beginPath();
    ctx.arc(
      bounds.x + radius,
      bounds.y + bounds.height - radius,
      cornerHandleDistance,
      Math.PI / 2,
      Math.PI
    );
    ctx.stroke();

    // Bottom-right corner
    ctx.beginPath();
    ctx.arc(
      bounds.x + bounds.width - radius,
      bounds.y + bounds.height - radius,
      cornerHandleDistance,
      0,
      Math.PI / 2
    );
    ctx.stroke();

    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    // Center handles
    ctx.beginPath();
    // Top center
    ctx.moveTo(centerX - handleLength / 2, bounds.y - sideHandleDistance);
    ctx.lineTo(centerX + handleLength / 2, bounds.y - sideHandleDistance);

    // Bottom center
    ctx.moveTo(
      centerX - handleLength / 2,
      bounds.y + bounds.height + sideHandleDistance
    );
    ctx.lineTo(
      centerX + handleLength / 2,
      bounds.y + bounds.height + sideHandleDistance
    );

    // Left center
    ctx.moveTo(bounds.x - sideHandleDistance, centerY - handleLength / 2);
    ctx.lineTo(bounds.x - sideHandleDistance, centerY + handleLength / 2);

    // Right center
    ctx.moveTo(
      bounds.x + bounds.width + sideHandleDistance,
      centerY - handleLength / 2
    );
    ctx.lineTo(
      bounds.x + bounds.width + sideHandleDistance,
      centerY + handleLength / 2
    );

    ctx.stroke();
  }

  // Clear bounds
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.clip();
  ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);

  // Guide lines (Rule of thirds)
  if (guideLines) {
    ctx.strokeStyle = prefersDark
      ? "rgba(255, 255, 255, 0.5)"
      : "rgba(0, 0, 0, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 2]);

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
    handles?: boolean;
    borderRadius?: number;
  }>
) {
  let canvasRef: HTMLCanvasElement | undefined;
  const [prefersDarkScheme, setPrefersDarkScheme] = createSignal(false);

  onMount(() => {
    if (!canvasRef) {
      console.error("Canvas ref was not setup");
      return;
    }

    const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDarkScheme(colorSchemeQuery.matches);
    const handleChange = (e: MediaQueryListEvent) =>
      setPrefersDarkScheme(e.matches);
    colorSchemeQuery.addEventListener("change", handleChange);

    const hidpiCanvas = createHiDPICanvasContext(canvasRef, (ctx) =>
      draw(
        ctx,
        props.bounds,
        props.borderRadius || 0,
        props.guideLines || false,
        props.handles || false,
        prefersDarkScheme()
      )
    );
    const ctx = hidpiCanvas?.ctx;
    if (!ctx) return;

    let lastAnimationFrameId: number | undefined;
    createEffect(() => {
      if (lastAnimationFrameId) cancelAnimationFrame(lastAnimationFrameId);

      const { x, y, width, height } = props.bounds;
      
      const prefersDark = prefersDarkScheme();
      lastAnimationFrameId = requestAnimationFrame(() =>
        draw(
          ctx,
          { x, y, width, height },
          props.borderRadius || 0,
          props.guideLines || false,
          props.handles || false,
          prefersDark
        )
      );
    });

    onCleanup(() => {
      if (lastAnimationFrameId) cancelAnimationFrame(lastAnimationFrameId);
      hidpiCanvas.cleanup();
      colorSchemeQuery.removeEventListener("change", handleChange);
    });
  });

  return (
    <div class="*:h-full *:w-full">
      <canvas ref={canvasRef} class="pointer-events-none absolute" />
      <div>{props.children}</div>
    </div>
  );
}
