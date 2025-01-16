import type { Bounds } from "~/utils/tauri";
import {
  onMount,
  onCleanup,
  createEffect,
  type ParentProps,
  createSignal,
} from "solid-js";
import { createHiDPICanvasContext } from "~/utils/canvas";

type DrawContext = {
  ctx: CanvasRenderingContext2D;
  bounds: Bounds;
  radius: number;
  prefersDark: boolean;
}

function drawHandles({ ctx, bounds, radius }: DrawContext) {
  const { x, y, width, height } = bounds;

  // Outline
  ctx.strokeStyle = "rgba(255, 255, 255, 1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.stroke();

  // Setup handle styles
  ctx.strokeStyle = "white";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.setLineDash([]);

  const cornerHandleLength = radius === 0 ? 20 : 10;

  // Corner handles
  const adjustedRadius = Math.min(radius, width / 2, height / 2);

  const x2 = x + width;
  const y2 = y + height;

  // top left
  ctx.beginPath();

  ctx.moveTo(x, y + adjustedRadius + cornerHandleLength);
  ctx.arcTo(x, y, x2, y, adjustedRadius);
  ctx.lineTo(x + adjustedRadius + cornerHandleLength, y);

  // top right
  ctx.moveTo(x2 - adjustedRadius - cornerHandleLength, y);
  ctx.arcTo(x2, y, x2, y2, adjustedRadius);
  ctx.lineTo(x2, y + adjustedRadius + cornerHandleLength);

  // bottom left
  ctx.moveTo(x + adjustedRadius + cornerHandleLength, y2);
  ctx.arcTo(x, y2, x, y, adjustedRadius);
  ctx.lineTo(x, y2 - adjustedRadius - cornerHandleLength);

  // bottom right
  ctx.moveTo(x2, y2 - adjustedRadius - cornerHandleLength);
  ctx.arcTo(x2, y2, x, y2, adjustedRadius);
  ctx.lineTo(x2 - adjustedRadius - cornerHandleLength, y2);

  ctx.stroke();

  // Center handles
  const handleLength = 35;
  const sideHandleDistance = 0;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  ctx.beginPath();

  // top center
  ctx.moveTo(centerX - handleLength / 2, bounds.y - sideHandleDistance);
  ctx.lineTo(centerX + handleLength / 2, bounds.y - sideHandleDistance);

  // bottom center
  ctx.moveTo(centerX - handleLength / 2, bounds.y + bounds.height + sideHandleDistance);
  ctx.lineTo(centerX + handleLength / 2, bounds.y + bounds.height + sideHandleDistance);

  // left center
  ctx.moveTo(bounds.x - sideHandleDistance, centerY - handleLength / 2);
  ctx.lineTo(bounds.x - sideHandleDistance, centerY + handleLength / 2);

  // right center
  ctx.moveTo(bounds.x + bounds.width + sideHandleDistance, centerY - handleLength / 2);
  ctx.lineTo(bounds.x + bounds.width + sideHandleDistance, centerY + handleLength / 2);

  ctx.stroke();
}

// Rule of thirds guide lines and center crosshair
function drawGuideLines({ ctx, bounds, prefersDark }: DrawContext) {
  ctx.strokeStyle = prefersDark
    ? "rgba(255, 255, 255, 0.5)"
    : "rgba(0, 0, 0, 0.5)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 2]);

  // Rule of thirds
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

  // Center crosshair
  const centerX = Math.round(bounds.x + bounds.width / 2);
  const centerY = Math.round(bounds.y + bounds.height / 2);

  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  const crosshairLength = 7;

  ctx.beginPath();
  ctx.moveTo(centerX - crosshairLength, centerY);
  ctx.lineTo(centerX + crosshairLength, centerY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX, centerY - crosshairLength);
  ctx.lineTo(centerX, centerY + crosshairLength);
  ctx.stroke();
}

// Main draw function
function draw(
  ctx: CanvasRenderingContext2D,
  bounds: Bounds,
  radius: number,
  guideLines: boolean,
  showHandles: boolean,
  prefersDark: boolean
) {
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const drawContext: DrawContext = { ctx, bounds, radius, prefersDark };

  ctx.save();

  // Clear the entire canvas
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Overlay
  ctx.fillStyle = prefersDark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 1)";
  ctx.shadowBlur = 200;
  ctx.shadowOffsetY = 25;
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.fill();
  ctx.restore();

  if (showHandles) drawHandles(drawContext);
  
  // Clear bounds
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.clip();
  ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);

  if (guideLines) drawGuideLines(drawContext);

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