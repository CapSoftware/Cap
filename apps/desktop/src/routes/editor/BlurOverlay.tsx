import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createRoot, createSignal, For, Show } from "solid-js";
import { cx } from "cva";
import { useEditorContext } from "./context";


interface BlurRectangleProps {
    rect: { x: number; y: number; width: number; height: number };
    style: { left: string; top: string; width: string; height: string; filter?: string };
    onUpdate: (rect: { x: number; y: number; width: number; height: number }) => void;
    containerBounds: { width?: number | null; height?: number | null };
    blurAmount: number;
    isEditing: boolean;
  }
  
export function BlurOverlay() {
  const { project, setProject, editorState } = useEditorContext();
  
  const [canvasContainerRef, setCanvasContainerRef] = createSignal<HTMLDivElement>();
  const containerBounds = createElementBounds(canvasContainerRef);

  const currentTime = () => editorState.previewTime ?? editorState.playbackTime ?? 0;
  

  const activeBlurSegmentsWithIndex = () => {
    return (project.timeline?.blurSegments || []).map((segment, index) => ({ segment, index })).filter(
      ({ segment }) => currentTime() >= segment.start && currentTime() <= segment.end
    );
  };

  const updateBlurRect = (index: number, rect: { x: number; y: number; width: number; height: number }) => {
    setProject("timeline", "blurSegments", index, "rect", rect);
  };

  const isSelected = (index: number) => {
    const selection = editorState.timeline.selection;
    return selection?.type === "blur" && selection.index === index;
  };

  return (
    <div
      ref={setCanvasContainerRef}
      class="absolute inset-0 pointer-events-none"
    >
      <For each={activeBlurSegmentsWithIndex()}>
        {({ segment, index }) => {
          // Convert normalized coordinates to pixel coordinates
          const rectStyle = () => {
            const containerWidth = containerBounds.width ?? 1;
            const containerHeight = containerBounds.height ?? 1;
            
            return {
              left: `${segment.rect.x * containerWidth}px`,
              top: `${segment.rect.y * containerHeight}px`,
              width: `${segment.rect.width * containerWidth}px`,
              height: `${segment.rect.height * containerHeight}px`,
            };
          };

          return (
            <BlurRectangle
              rect={segment.rect}
              style={rectStyle()}
              blurAmount={segment.blur_amount || 0}
              onUpdate={(newRect) => updateBlurRect(index, newRect)}
              containerBounds={containerBounds}
              isEditing={isSelected(index)}
            />
          );
        }}
      </For>
    </div>
  );
}



function BlurRectangle(props: BlurRectangleProps) {
  const handleMouseDown = (e: MouseEvent, action: 'move' | 'resize', corner?: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    const containerWidth = props.containerBounds.width ?? 1;
    const containerHeight = props.containerBounds.height ?? 1;
    
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...props.rect };
  
    createRoot((dispose) => {
      createEventListenerMap(window, {
        mousemove: (moveEvent: MouseEvent) => {
          const deltaX = (moveEvent.clientX - startX) / containerWidth;
          const deltaY = (moveEvent.clientY - startY) / containerHeight;

          let newRect = { ...startRect };

          if (action === 'move') {
            // Clamp the new position to stay within the 0.0 to 1.0 bounds
            newRect.x = Math.max(0, Math.min(1 - newRect.width, startRect.x + deltaX));
            newRect.y = Math.max(0, Math.min(1 - newRect.height, startRect.y + deltaY));
          } else if (action === 'resize') {
            // --- This resize logic needs the bounds check ---
            let right = startRect.x + startRect.width;
            let bottom = startRect.y + startRect.height;

            if (corner?.includes('w')) { // West (left) handles
              newRect.x = Math.max(0, startRect.x + deltaX);
              newRect.width = right - newRect.x;
            }
            if (corner?.includes('n')) { // North (top) handles
              newRect.y = Math.max(0, startRect.y + deltaY);
              newRect.height = bottom - newRect.y;
            }
            if (corner?.includes('e')) { // East (right) handles
              right = Math.min(1, right + deltaX);
              newRect.width = right - newRect.x;
            }
            if (corner?.includes('s')) { // South (bottom) handles
              bottom = Math.min(1, bottom + deltaY);
              newRect.height = bottom - newRect.y;
            }
          }
          
          // Ensure minimum size after any operation
          if (newRect.width < 0.05) newRect.width = 0.05;
          if (newRect.height < 0.05) newRect.height = 0.05;

          props.onUpdate(newRect);
        },
        mouseup: () => {
          dispose();
        },
      });
    });
  };
  const scaledBlurAmount = () => (props.blurAmount ?? 0) * 20;
  return (
    <div
      class={cx(
        "absolute",
        props.isEditing ? "pointer-events-auto border-2 border-blue-400 bg-blue-400/20" : "pointer-events-none border-none bg-transparent"
      )}
      style={{
        ...props.style,
        "backdrop-filter": `blur(${scaledBlurAmount()}px)`,
        "-webkit-backdrop-filter": `blur(${scaledBlurAmount()}px)`,
      }}
    >
      <Show when={props.isEditing}>
        {/* Main draggable area */}
        <div
          class="absolute inset-0 cursor-move"
          onMouseDown={(e) => handleMouseDown(e, 'move')}
        />
        
        {/* Resize handles */}
        <div
          class="absolute -top-1 -left-1 w-3 h-3 bg-blue-400 border border-white cursor-nw-resize rounded-full"
          onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')}
        />
        <div
          class="absolute -top-1 -right-1 w-3 h-3 bg-blue-400 border border-white cursor-ne-resize rounded-full"
          onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')}
        />
        <div
          class="absolute -bottom-1 -left-1 w-3 h-3 bg-blue-400 border border-white cursor-sw-resize rounded-full"
          onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')}
        />
        <div
          class="absolute -bottom-1 -right-1 w-3 h-3 bg-blue-400 border border-white cursor-se-resize rounded-full"
          onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')}
        />
        
        {/* Center label */}
        {/* <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="px-2 py-1 bg-blue-500 text-white text-xs rounded shadow-lg">
            <IconCapBlur class="inline w-3 h-3 mr-1" />
            Blur Area
          </div>
        </div> */}
      </Show>
    </div>
  );
}