import type { Bounds } from "~/utils/tauri";
import {
  type ParentProps,
  onMount,
  onCleanup,
  createEffect,
  createSignal,
  createMemo,
} from "solid-js";
import { createHiDPICanvasContext } from "~/utils/canvas";

type DrawContext = {
  ctx: CanvasRenderingContext2D;
  bounds: Bounds;
  radius: number;
  prefersDark: boolean;
  highlighted: boolean;
  selected: boolean;
};

function drawHandles({
  ctx,
  bounds,
  radius,
  highlighted,
  selected,
}: DrawContext) {
  const { x, y, width, height } = bounds;
  const minSizeForSideHandles = 100;

  ctx.strokeStyle = selected
    ? "rgba(255, 255, 255, 1)"
    : highlighted
    ? "rgba(60, 150, 280, 1)"
    : "rgba(255, 255, 255, 1)";

  ctx.lineWidth = 4;
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

  // Only draw side handles if there's enough space.
  if (!(width > minSizeForSideHandles && height > minSizeForSideHandles)) {
    return;
  }

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
  ctx.moveTo(
    centerX - handleLength / 2,
    bounds.y + bounds.height + sideHandleDistance
  );
  ctx.lineTo(
    centerX + handleLength / 2,
    bounds.y + bounds.height + sideHandleDistance
  );

  // left center
  ctx.moveTo(bounds.x - sideHandleDistance, centerY - handleLength / 2);
  ctx.lineTo(bounds.x - sideHandleDistance, centerY + handleLength / 2);

  // right center
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

// Rule of thirds guide lines and center crosshair
function drawGuideLines(
  { ctx, bounds, prefersDark }: DrawContext,
  opacity: number = 1
) {
  const baseColor = prefersDark ? [255, 255, 255] : [0, 0, 0];
  ctx.strokeStyle = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, ${
    0.5 * opacity
  })`;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 2]);

  // Rule of thirds
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    const x = bounds.x + (bounds.width * i) / 3;
    ctx.moveTo(x, bounds.y);
    ctx.lineTo(x, bounds.y + bounds.height);
  }
  ctx.stroke();

  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    const y = bounds.y + (bounds.height * i) / 3;
    ctx.moveTo(bounds.x, y);
    ctx.lineTo(bounds.x + bounds.width, y);
  }
  ctx.stroke();

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
  highlighted: boolean,
  selected: boolean,
  prefersDark: boolean,
  borderColor?: string,
  guideLinesOpacity: number = 1
) {
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const drawContext: DrawContext = {
    ctx,
    bounds,
    radius,
    prefersDark,
    highlighted,
    selected,
  };

  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 15;
  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
  ctx.clip();
  ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);

  if (guideLinesOpacity > 0) drawGuideLines(drawContext, guideLinesOpacity);

  if (borderColor) {
    ctx.beginPath();
    ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.restore();

  if (showHandles) {
    ctx.strokeStyle = selected
      ? "rgba(255, 255, 255, 0.8)"
      : highlighted
      ? "rgba(60, 150, 280, 0.8)"
      : "rgba(255, 255, 255, 0.4)";

    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
    ctx.stroke();

    drawHandles(drawContext);
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return null;
  return match.slice(1).map((c) => Number.parseInt(c, 16)) as any;
}

export default function CropAreaRenderer(
  props: ParentProps<{
    bounds: Bounds;
    guideLines?: boolean;
    handles?: boolean;
    borderRadius?: number;
    highlighted?: boolean;
    selected?: boolean;
    borderColor?: string;
  }>
) {
  let canvasRef: HTMLCanvasElement | null = null;
  const [prefersDarkScheme, setPrefersDarkScheme] = createSignal(false);
  const borderColorRgba = createMemo(() => {
    if (!props.borderColor) return;
    const rgb = hexToRgb(props.borderColor);
    if (!rgb) return "rgba(70, 134, 255, 0.5)";
    // prettier-ignore
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.5)`;
  });

  const GUIDE_LINES_ANIM_DURATION_MS = 150;

  let guideLinesOpacity = props.guideLines ? 1 : 0;
  let targetOpacity = props.guideLines ? 1 : 0;
  let animating = false;
  let animationFrameId: number | null = null;

  let latestProps = { ...props };
  let latestPrefersDark = prefersDarkScheme();

  createEffect(() => {
    latestProps = { ...props };
    latestPrefersDark = prefersDarkScheme();
    // Only redraw if not animating
    if (!animating) {
      redraw();
    }
  });

  function animateGuideLinesOpacity(to: number) {
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    animating = true;
    const from = guideLinesOpacity;
    const start = performance.now();
    targetOpacity = to;

    function step(now: number) {
      // Easing: ease-in-out
      const t = Math.min((now - start) / GUIDE_LINES_ANIM_DURATION_MS, 1);
      const eased = t * (2 - t);
      guideLinesOpacity = from + (to - from) * eased;
      redraw();
      if (
        (to > from && guideLinesOpacity < to) ||
        (to < from && guideLinesOpacity > to)
      ) {
        animationFrameId = requestAnimationFrame(step);
      } else {
        guideLinesOpacity = to;
        animating = false;
        redraw();
      }
    }
    animationFrameId = requestAnimationFrame(step);
  }

  let ctx: CanvasRenderingContext2D | null = null;
  function redraw() {
    if (!ctx) return;
    draw(
      ctx,
      latestProps.bounds,
      latestProps.borderRadius || 0,
      latestProps.guideLines || false,
      latestProps.handles || false,
      latestProps.highlighted || false,
      latestProps.selected || false,
      latestPrefersDark,
      borderColorRgba(),
      guideLinesOpacity
    );
  }

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

    const hidpiCanvas = createHiDPICanvasContext(canvasRef, (c) => {
      ctx = c;
      redraw();
    });
    ctx = hidpiCanvas?.ctx ?? null;

    let lastFrameId: number | null = null;

    createEffect(() => {
      // Animate guide lines opacity on prop change
      const shouldShow = props.guideLines || false;
      if (shouldShow !== guideLinesOpacity > 0.5) {
        animateGuideLinesOpacity(shouldShow ? 1 : 0);
      } else {
        redraw();
      }
      // Redraw on other prop changes
      if (lastFrameId !== null) cancelAnimationFrame(lastFrameId);
      lastFrameId = requestAnimationFrame(() => {
        redraw();
      });
    });

    onCleanup(() => {
      if (lastFrameId !== null) cancelAnimationFrame(lastFrameId);
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      colorSchemeQuery.removeEventListener("change", handleChange);
      hidpiCanvas?.cleanup();
    });
  });

  return (
    <div class="*:h-full *:w-full animate-in fade-in">
      <canvas
        ref={(el) => (canvasRef = el)}
        class="pointer-events-none absolute"
      />
      <div>{props.children}</div>
    </div>
  );
}
