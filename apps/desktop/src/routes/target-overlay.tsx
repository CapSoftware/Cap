import { createMutation, createQuery } from "@tanstack/solid-query";
import { Menu } from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  createCurrentRecordingQuery,
  createOptionsQuery,
  listScreens,
} from "~/utils/queries";
import { commands } from "~/utils/tauri";
import display from "../assets/illustrations/display.png";

export default function TargetOverlay() {
  // Initialize with dummy values that will be updated on mount
  const [position, setPosition] = createSignal({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = createSignal(false);
  const [dragOffset, setDragOffset] = createSignal({ x: 0, y: 0 });
  const [boxSize, setBoxSize] = createSignal({ width: 0, height: 0 });
  const [screenSize, setScreenSize] = createSignal({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [isPositioned, setIsPositioned] = createSignal(false);
  const [selectedMode, setSelectedMode] = createSignal("Instant mode");
  let boxRef!: HTMLDivElement;
  let dropdownRef!: HTMLDivElement;

  const { options } = createOptionsQuery();

  const currentRecording = createCurrentRecordingQuery();
  const isRecording = () => !!currentRecording.data;

  // Function to center the box on the screen
  const centerBox = () => {
    if (boxSize().width > 0 && boxSize().height > 0) {
      const centerX = (screenSize().width - boxSize().width) / 2;
      const centerY = (screenSize().height - boxSize().height) / 2;
      setPosition({ x: centerX, y: centerY });
      // Mark as positioned after setting the position
      setIsPositioned(true);
    }
  };

  const close = async () => {
    (await WebviewWindow.getByLabel("main-new"))?.unminimize();
    await getCurrentWindow()?.close();
  };

  const screens = createQuery(() => listScreens);
  const toggleRecording = createMutation(() => ({
    mutationFn: async () => {
      if (!isRecording()) {
        //manually setting the screen until its done properly
        await commands.startRecording({
          captureTarget: {
            variant: "screen",
            id: screens.data?.[0]?.id ?? 1,
          },
          mode: options.data?.mode ?? "studio",
          cameraLabel: options.data?.cameraLabel ?? null,
          audioInputName: options.data?.audioInputName ?? null,
        });
        await close();
      } else {
        await commands.stopRecording();
      }
    },
  }));

  const handleMouseDown = (e: MouseEvent) => {
    if (boxRef) {
      const box = boxRef.getBoundingClientRect();
      setBoxSize({ width: box.width, height: box.height });
      setDragOffset({
        x: e.clientX - box.left,
        y: e.clientY - box.top,
      });
      setIsDragging(true);
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging()) {
      // Calculate new position
      let newX = e.clientX - dragOffset().x;
      let newY = e.clientY - dragOffset().y;

      // Apply boundary constraints
      newX = Math.max(0, Math.min(newX, screenSize().width - boxSize().width));
      newY = Math.max(
        0,
        Math.min(newY, screenSize().height - boxSize().height)
      );

      setPosition({
        x: newX,
        y: newY,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleResize = () => {
    setScreenSize({ width: window.innerWidth, height: window.innerHeight });

    // Also adjust position if it's now outside the screen after resize
    setPosition((prev) => {
      let x = Math.max(
        0,
        Math.min(prev.x, screenSize().width - boxSize().width)
      );
      let y = Math.max(
        0,
        Math.min(prev.y, screenSize().height - boxSize().height)
      );
      return { x, y };
    });
  };

  onMount(async () => {
    const handleGlobalMouseMove = (e: MouseEvent) => handleMouseMove(e);
    const handleGlobalMouseUp = () => handleMouseUp();

    // Get initial box size and center it
    if (boxRef) {
      // Use requestAnimationFrame to ensure DOM is fully rendered
      requestAnimationFrame(() => {
        const box = boxRef.getBoundingClientRect();
        setBoxSize({ width: box.width, height: box.height });
        centerBox();
      });
    }

    // Add event listeners
    document.addEventListener("mousemove", handleGlobalMouseMove);
    document.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("resize", handleResize);

    onCleanup(() => {
      document.removeEventListener("mousemove", handleGlobalMouseMove);
      document.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("resize", handleResize);
    });
  });

  async function modeMenu(event: MouseEvent) {
    event.preventDefault();
    const menu = await Menu.new({
      items: [
        {
          id: "instant",
          text: "Instant mode",
          checked: selectedMode() === "Instant mode",
          action: () => setSelectedMode("Instant mode"),
        },
        {
          id: "studio",
          text: "Studio mode",
          checked: selectedMode() === "Studio mode",
          action: () => setSelectedMode("Studio mode"),
        },
      ],
    });
    const dropdownPosition = dropdownRef.getBoundingClientRect();
    await menu.popup(
      new LogicalPosition(
        dropdownPosition.left + 80,
        dropdownPosition.bottom - 15
      )
    );
  }

  return (
    <div class="w-screen h-screen bg-blue-transparent-40">
      <div
        ref={boxRef}
        onMouseDown={handleMouseDown}
        style={{
          position: "absolute",
          left: `${position().x}px`,
          top: `${position().y}px`,
          cursor: isDragging() ? "grabbing" : "grab",
          opacity: isPositioned() ? 1 : 0,
          transition: "opacity 0.1s ease-in-out",
          visibility: isPositioned() ? "visible" : "hidden",
        }}
      >
        <img class="w-[200px] pointer-events-none mx-auto mb-5" src={display} />
        <div class="text-center">
          <h1 class="text-[40px] font-bold text-white">
            {screens.data?.[0]?.name}
          </h1>
          <p class="text-white">
            {window.innerWidth} x {window.innerHeight} -{" "}
            {screens.data?.[0]?.refresh_rate} FPS
          </p>
        </div>
        <div class="flex gap-4 border border-zinc-300 items-center p-3 mx-auto mt-5 bg-white rounded-[20px] w-fit dark:bg-zinc-200">
          <button
            onClick={close}
            class="flex justify-center items-center rounded-full border duration-200 cursor-pointer hover:bg-zinc-350 size-8 bg-zinc-300 border-zinc-350"
          >
            <IconCapClose class="size-3" />
          </button>
          <div
            ref={dropdownRef}
            onClick={() => toggleRecording.mutate()}
            class="flex flex-row items-center p-3 rounded-[12px] font-medium bg-blue-300 transition-colors duration-200 cursor-pointer hover:bg-blue-400"
          >
            <IconCapInstant class="mr-3 size-6" />
            <div class="leading-tight">
              <p class="text-white">Start Recording</p>
              <p class="-mt-0.5 text-sm text-white opacity-50">
                {selectedMode()}
              </p>
            </div>
            <div
              class="p-2 ml-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-blue-500"
              onClick={(e) => {
                e.stopPropagation(); // Prevent the parent onClick from firing
                modeMenu(e);
              }}
            >
              <IconCapChevronDown class="size-5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
