import {
  Collapsible,
  Collapsible as KCollapsible,
} from "@kobalte/core/collapsible";
import {
  RadioGroup as KRadioGroup,
  RadioGroup,
} from "@kobalte/core/radio-group";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createWritableMemo } from "@solid-primitives/memo";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { cx } from "cva";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  on,
  onMount,
} from "solid-js";
import { produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";

import { createElementBounds } from "@solid-primitives/bounds";
import { type as ostype } from "@tauri-apps/plugin-os";
import toast from "solid-toast";
import colorBg from "~/assets/illustrations/color.webp";
import gradientBg from "~/assets/illustrations/gradient.webp";
import imageBg from "~/assets/illustrations/image.webp";
import transparentBg from "~/assets/illustrations/transparent.webp";
import { generalSettingsStore } from "~/store";
import {
  type BackgroundSource,
  type CursorAnimationStyle,
  commands,
} from "~/utils/tauri";
import { BACKGROUND_THEMES, useEditorContext } from "./context";
import {
  DEFAULT_GRADIENT_FROM,
  DEFAULT_GRADIENT_TO,
  RGBColor,
} from "./projectConfig";
import ShadowSettings from "./ShadowSettings";
import { TextInput } from "./TextInput";
import {
  ComingSoonTooltip,
  EditorButton,
  Field,
  Slider,
  Subfield,
  Toggle,
} from "./ui";
import { CaptionsTab } from "./CaptionsTab";


const BACKGROUND_SOURCES = {
  wallpaper: "Wallpaper",
  image: "Image",
  color: "Color",
  gradient: "Gradient",
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_ICONS = {
  wallpaper: imageBg,
  image: transparentBg,
  color: colorBg,
  gradient: gradientBg,
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_SOURCES_LIST = [
  "wallpaper",
  "image",
  "color",
  "gradient",
] satisfies Array<BackgroundSource["type"]>;

const CURSOR_ANIMATION_STYLES: Record<CursorAnimationStyle, string> = {
  slow: "Slow & Smooth",
  regular: "Regular",
  fast: "Fast & Responsive",
} as const;

const BACKGROUND_COLORS = [
  "#FF0000", // Red
  "#FF4500", // Orange-Red
  "#FF8C00", // Orange
  "#FFD700", // Gold
  "#FFFF00", // Yellow
  "#ADFF2F", // Green-Yellow
  "#32CD32", // Lime Green
  "#008000", // Green
  "#00CED1", // Dark Turquoise
  "#4785FF", // Dodger Blue
  "#0000FF", // Blue
  "#4B0082", // Indigo
  "#800080", // Purple
  "#A9A9A9", // Dark Gray
  "#FFFFFF", // White
  "#000000", // Black
];

const BACKGROUND_GRADIENTS = [
  { from: [15, 52, 67], to: [52, 232, 158] }, // Dark Blue to Teal
  { from: [34, 193, 195], to: [253, 187, 45] }, // Turquoise to Golden Yellow
  { from: [29, 253, 251], to: [195, 29, 253] }, // Cyan to Purple
  { from: [69, 104, 220], to: [176, 106, 179] }, // Blue to Violet
  { from: [106, 130, 251], to: [252, 92, 125] }, // Soft Blue to Pinkish Red
  { from: [131, 58, 180], to: [253, 29, 29] }, // Purple to Red
  { from: [249, 212, 35], to: [255, 78, 80] }, // Yellow to Coral Red
  { from: [255, 94, 0], to: [255, 42, 104] }, // Orange to Reddish Pink
  { from: [255, 0, 150], to: [0, 204, 255] }, // Pink to Sky Blue
  { from: [0, 242, 96], to: [5, 117, 230] }, // Green to Blue
  { from: [238, 205, 163], to: [239, 98, 159] }, // Peach to Soft Pink
  { from: [44, 62, 80], to: [52, 152, 219] }, // Dark Gray Blue to Light Blue
  { from: [168, 239, 255], to: [238, 205, 163] }, // Light Blue to Peach
  { from: [74, 0, 224], to: [143, 0, 255] }, // Deep Blue to Bright Purple
  { from: [252, 74, 26], to: [247, 183, 51] }, // Deep Orange to Soft Yellow
  { from: [0, 255, 255], to: [255, 20, 147] }, // Cyan to Deep Pink
  { from: [255, 127, 0], to: [255, 255, 0] }, // Orange to Yellow
  { from: [255, 0, 255], to: [0, 255, 0] }, // Magenta to Green
] satisfies Array<{ from: RGBColor; to: RGBColor }>;

const WALLPAPER_NAMES = [
  // macOS wallpapers
  "macOS/sequoia-dark",
  "macOS/sequoia-light",
  "macOS/sonoma-clouds",
  "macOS/sonoma-dark",
  "macOS/sonoma-evening",
  "macOS/sonoma-fromabove",
  "macOS/sonoma-horizon",
  "macOS/sonoma-light",
  "macOS/sonoma-river",
  "macOS/ventura-dark",
  "macOS/ventura-semi-dark",
  "macOS/ventura",
  // Blue wallpapers
  "blue/1",
  "blue/2",
  "blue/3",
  "blue/4",
  "blue/5",
  "blue/6",
  // Purple wallpapers
  "purple/1",
  "purple/2",
  "purple/3",
  "purple/4",
  "purple/5",
  "purple/6",
  // Dark wallpapers
  "dark/1",
  "dark/2",
  "dark/3",
  "dark/4",
  "dark/5",
  "dark/6",
  // Orange wallpapers
  "orange/1",
  "orange/2",
  "orange/3",
  "orange/4",
  "orange/5",
  "orange/6",
  "orange/7",
  "orange/8",
  "orange/9",
] as const;

export function ConfigSidebar() {
  const {
    backgroundTab,
    setBackgroundTab,
    selectedTab,
    setSelectedTab,
    project,
    setProject,
    editorInstance,
    state,
    setState,
    history,
  } = useEditorContext();

  const [wallpapers, { mutate }] = createResource(async () => {
    // Only load visible wallpapers initially
    const visibleWallpaperPaths = WALLPAPER_NAMES.slice(0, 50).map(
      async (id) => {
        try {
          const path = await commands.getWallpaperPath(id);
          return { id, path };
        } catch (err) {
          return { id, path: null };
        }
      }
    );

    // Load initial batch
    const initialPaths = await Promise.all(visibleWallpaperPaths);

    return initialPaths
      .filter((p) => p.path !== null)
      .map(({ id, path }) => ({
        id,
        url: convertFileSrc(path!),
        rawPath: path!,
      }));
  });

  // Add a signal to track if additional wallpapers are being loaded
  const [loadingMore, setLoadingMore] = createSignal(false);
  // Add a signal to track if all wallpapers are loaded
  const [allWallpapersLoaded, setAllWallpapersLoaded] = createSignal(false);

  // Function to load more wallpapers
  const loadMoreWallpapers = async () => {
    if (loadingMore() || allWallpapersLoaded()) return;

    setLoadingMore(true);
    const currentLength = wallpapers()?.length || 0;

    if (currentLength >= WALLPAPER_NAMES.length) {
      setAllWallpapersLoaded(true);
      setLoadingMore(false);
      return;
    }

    const nextBatch = WALLPAPER_NAMES.slice(currentLength, currentLength + 21);
    const newPaths = await Promise.all(
      nextBatch.map(async (id) => {
        try {
          const path = await commands.getWallpaperPath(id);
          return { id, path };
        } catch (err) {
          return { id, path: null };
        }
      })
    );

    const newWallpapers = newPaths
      .filter((p) => p.path !== null)
      .map(({ id, path }) => ({
        id,
        url: convertFileSrc(path!),
        rawPath: path!,
      }));

    mutate((prev) => [...(prev || []), ...newWallpapers]);
    setLoadingMore(false);
  };

  const filteredWallpapers = createMemo(() => {
    const currentTab = backgroundTab();
    return wallpapers()?.filter((wp) => wp.id.startsWith(currentTab)) || [];
  });

  // Validate background source path on mount
  onMount(async () => {
    if (
      project.background.source.type === "wallpaper" ||
      project.background.source.type === "image"
    ) {
      const path = project.background.source.path;

      if (path) {
        if (project.background.source.type === "wallpaper") {
          // If the path is just the wallpaper ID (e.g. "sequoia-dark"), get the full path
          if (
            WALLPAPER_NAMES.includes(path as (typeof WALLPAPER_NAMES)[number])
          ) {
            // Wait for wallpapers to load
            const loadedWallpapers = await wallpapers();
            if (!loadedWallpapers) return;

            // Find the wallpaper with matching ID
            const wallpaper = loadedWallpapers.find((w) => w.id === path);
            if (!wallpaper?.url) return;

            // Directly trigger the radio group's onChange handler
            const radioGroupOnChange = async (photoUrl: string) => {
              try {
                const wallpaper = wallpapers()?.find((w) => w.url === photoUrl);
                if (!wallpaper) return;

                // Get the raw path without any URL prefixes
                const rawPath = decodeURIComponent(
                  photoUrl.replace("file://", "")
                );

                debouncedSetProject(rawPath);
              } catch (err) {
                toast.error("Failed to set wallpaper");
              }
            };

            await radioGroupOnChange(wallpaper.url);
          }
        } else if (project.background.source.type === "image") {
          (async () => {
            try {
              const convertedPath = convertFileSrc(path);
              await fetch(convertedPath, { method: "HEAD" });
            } catch (err) {
              setProject("background", "source", {
                type: "image",
                path: null,
              });
            }
          })();
        }
      }
    }
  });

  const backgrounds: {
    [K in BackgroundSource["type"]]: Extract<BackgroundSource, { type: K }>;
  } = {
    wallpaper: {
      type: "wallpaper",
      path: null,
    },
    image: {
      type: "image",
      path: null,
    },
    color: {
      type: "color",
      value: DEFAULT_GRADIENT_FROM,
    },
    gradient: {
      type: "gradient",
      from: DEFAULT_GRADIENT_FROM,
      to: DEFAULT_GRADIENT_TO,
    },
  };

  const [previousAngle, setPreviousAngle] = createSignal(0);
  const [hapticsEnabled, hapticsEnabledOptions] = createResource(
    async () =>
      (await generalSettingsStore.get())?.hapticsEnabled && ostype() === "macos"
  );
  generalSettingsStore.listen(() => hapticsEnabledOptions.refetch());

  let fileInput!: HTMLInputElement;
  let scrollRef!: HTMLDivElement;

  //needs to be a signal as the ref is lost otherwise when changing tabs
  const [backgroundRef, setBackgroundRef] = createSignal<HTMLDivElement>();

  const [scrollX, setScrollX] = createSignal(0);
  const [reachedEndOfScroll, setReachedEndOfScroll] = createSignal(false);

  // Optimize the debounced set project function
  const debouncedSetProject = (wallpaperPath: string) => {
    const resumeHistory = history.pause();
    queueMicrotask(() => {
      batch(() => {
        setProject("background", "source", {
          type: "wallpaper",
          path: wallpaperPath,
        } as const);
        resumeHistory();
      });
    });
  };

  /** Handle background tabs overflowing to show fade */

  const handleScroll = () => {
    const el = backgroundRef();
    if (el) {
      setScrollX(el.scrollLeft);
      const reachedEnd = el.scrollWidth - el.clientWidth - el.scrollLeft;
      setReachedEndOfScroll(reachedEnd === 0);
    }
  };

  //Mouse wheel and touchpad support
  const handleWheel = (e: WheelEvent) => {
    const el = backgroundRef();
    if (el) {
      e.preventDefault();
      el.scrollLeft +=
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    }
  };

  createEffect(() => {
    const el = backgroundRef();
    if (el) {
      el.addEventListener("scroll", handleScroll);
      el.addEventListener("wheel", handleWheel, { passive: false });

      return () => {
        el.removeEventListener("scroll", handleScroll);
        el.removeEventListener("wheel", handleWheel);
      };
    }
  });

  return (
    <KTabs
      value={selectedTab()}
      class="flex flex-col shrink-0 flex-1 max-w-[26rem] overflow-hidden rounded-t-xl z-10 bg-gray-100 relative"
    >
      <KTabs.List class="flex overflow-hidden relative z-40 flex-row items-center h-16 text-lg border-b border-gray-200 shrink-0">
        <For
          each={[
            { id: "background" as const, icon: IconCapImage },
            {
              id: "camera" as const,
              icon: IconCapCamera,
              disabled: editorInstance.recordings.segments.every(
                (s) => s.camera === null
              ),
            },
            // {
            //   id: "transcript" as const,
            //   icon: IconCapMessageBubble,
            // },
            { id: "audio" as const, icon: IconCapAudioOn },
            { id: "cursor" as const, icon: IconCapCursor },
            { id: "captions" as const, icon: IconCapMessageBubble },
            // { id: "hotkeys" as const, icon: IconCapHotkeys },
          ]}
        >
          {(item) => (
            <KTabs.Trigger
              value={item.id}
              class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 text-gray-400 transition-colors group ui-selected:text-gray-500 disabled:opacity-50 focus:outline-none"
              onClick={() => {
                setSelectedTab(item.id);
                scrollRef.scrollTo({
                  top: 0,
                });
              }}
              disabled={item.disabled}
            >
              <div
                class={cx(
                  "flex justify-center relative border-transparent border z-10 items-center rounded-md size-9 transition will-change-transform",
                  selectedTab() !== item.id && "group-hover:border-gray-300"
                )}
              >
                <Dynamic component={item.icon} />
              </div>
            </KTabs.Trigger>
          )}
        </For>

        {/** Center the indicator with the icon */}
        <KTabs.Indicator class="absolute top-0 left-0 w-full h-full transition-transform duration-300 ease-in-out pointer-events-none will-change-transform">
          <div class="absolute top-1/2 left-1/2 bg-gray-200 rounded-md transform -translate-x-1/2 -translate-y-1/2 will-change-transform size-9" />
        </KTabs.Indicator>
      </KTabs.List>
      <div
        ref={scrollRef}
        class="p-4 custom-scroll overflow-x-hidden overflow-y-auto text-[0.875rem] h-full"
      >
        <KTabs.Content value="background" class="flex flex-col gap-8">
          <Field icon={<IconCapImage class="size-4" />} name="Background Image">
            <KTabs
              value={project.background.source.type}
              onChange={(v) => {
                const tab = v as BackgroundSource["type"];
                switch (tab) {
                  case "image": {
                    setProject("background", "source", {
                      type: "image",
                      path:
                        project.background.source.type === "image"
                          ? project.background.source.path
                          : null,
                    });
                    break;
                  }
                  case "color": {
                    setProject("background", "source", {
                      type: "color",
                      value:
                        project.background.source.type === "color"
                          ? project.background.source.value
                          : DEFAULT_GRADIENT_FROM,
                    });
                    break;
                  }
                  case "gradient": {
                    setProject("background", "source", {
                      type: "gradient",
                      from:
                        project.background.source.type === "gradient"
                          ? project.background.source.from
                          : DEFAULT_GRADIENT_FROM,
                      to:
                        project.background.source.type === "gradient"
                          ? project.background.source.to
                          : DEFAULT_GRADIENT_TO,
                      angle:
                        project.background.source.type === "gradient"
                          ? project.background.source.angle
                          : 90,
                    });
                    break;
                  }
                  case "wallpaper": {
                    setProject("background", "source", {
                      type: "wallpaper",
                      path:
                        project.background.source.type === "wallpaper"
                          ? project.background.source.path
                          : null,
                    });
                    break;
                  }
                }
              }}
            >
              <KTabs.List class="flex flex-row  gap-2 items-center rounded-[0.5rem] relative">
                <For each={BACKGROUND_SOURCES_LIST}>
                  {(item) => {
                    const el = (props?: object) => (
                      <KTabs.Trigger
                        class="z-10 flex-1 py-2.5 px-2 text-xs text-gray-400 ui-selected:bg-gray-200 ui-not-selected:hover:border-gray-300 rounded-[10px] transition-colors duration-300 outline-none border ui-selected:text-gray-500 peer"
                        value={item}
                        {...props}
                      >
                        <div class="flex gap-1.5 justify-center items-center">
                          {(() => {
                            const getGradientBackground = () => {
                              const angle =
                                project.background.source.type === "gradient"
                                  ? project.background.source.angle
                                  : 90;
                              const fromColor =
                                project.background.source.type === "gradient"
                                  ? project.background.source.from
                                  : DEFAULT_GRADIENT_FROM;
                              const toColor =
                                project.background.source.type === "gradient"
                                  ? project.background.source.to
                                  : DEFAULT_GRADIENT_TO;

                              return (
                                <div
                                  class="size-3.5 rounded"
                                  style={{
                                    background: `linear-gradient(${angle}deg, rgb(${fromColor}), rgb(${toColor}))`,
                                  }}
                                />
                              );
                            };

                            const getColorBackground = () => {
                              const backgroundColor =
                                project.background.source.type === "color"
                                  ? project.background.source.value
                                  : hexToRgb(BACKGROUND_COLORS[9]);

                              return (
                                <div
                                  class="size-3.5 rounded-[5px]"
                                  style={{
                                    "background-color": `rgb(${backgroundColor})`,
                                  }}
                                />
                              );
                            };

                            const getImageBackground = () => {
                              // Always start with the default icon
                              let imageSrc: string = BACKGROUND_ICONS[item];

                              // Only override for "image" if a valid path exists
                              if (
                                item === "image" &&
                                project.background.source.type === "image" &&
                                project.background.source.path
                              ) {
                                const convertedPath = convertFileSrc(
                                  project.background.source.path
                                );
                                // Only use converted path if it's valid
                                if (convertedPath) {
                                  imageSrc = convertedPath;
                                }
                              } 
                              // Only override for "wallpaper" if a valid wallpaper is found
                              else if (
                                item === "wallpaper" &&
                                project.background.source.type === "wallpaper" &&
                                project.background.source.path
                              ) {
                                const selectedWallpaper = wallpapers()?.find(
                                  (w) =>
                                    (
                                      project.background.source as {
                                        path?: string;
                                      }
                                    ).path?.includes(w.id)
                                );
                                // Only use wallpaper URL if it exists
                                if (selectedWallpaper?.url) {
                                  imageSrc = selectedWallpaper.url;
                                }
                              }

                              return (
                                <img
                                  loading="eager"
                                  alt={BACKGROUND_SOURCES[item]}
                                  class="size-3.5 rounded"
                                  src={imageSrc}
                                />
                              );
                            };

                            switch (item) {
                              case "gradient":
                                return getGradientBackground();
                              case "color":
                                return getColorBackground();
                              case "image":
                              case "wallpaper":
                                return getImageBackground();
                              default:
                                return null;
                            }
                          })()}
                          {BACKGROUND_SOURCES[item]}
                        </div>
                      </KTabs.Trigger>
                    );

                    return el({});
                  }}
                </For>

                {/* <KTabs.Indicator class="flex overflow-hidden absolute inset-0 p-px rounded-xl transition-transform duration-300 peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 outline-blue-300/50">
                  <div class="flex-1 bg-gray-200" />
                </KTabs.Indicator> */}
              </KTabs.List>
              {/** Dashed divider */}
              <div class="my-5 w-full border-t border-gray-300 border-dashed" />
              <KTabs.Content value="wallpaper">
                {/** Background Tabs */}
                <KTabs class="overflow-hidden relative" value={backgroundTab()}>
                  <KTabs.List
                    ref={setBackgroundRef}
                    class="flex overflow-x-auto overscroll-contain relative z-40 flex-row gap-2 items-center mb-5 text-xs hide-scroll"
                    style={{
                      "-webkit-mask-image": `linear-gradient(to right, transparent, black ${
                        scrollX() > 0 ? "24px" : "0"
                      }, black calc(100% - ${
                        reachedEndOfScroll() ? "0px" : "24px"
                      }), transparent)`,

                      "mask-image": `linear-gradient(to right, transparent, black ${
                        scrollX() > 0 ? "24px" : "0"
                      }, black calc(100% - ${
                        reachedEndOfScroll() ? "0px" : "24px"
                      }), transparent);`,
                    }}
                  >
                    <For each={Object.entries(BACKGROUND_THEMES)}>
                      {([key, value]) => (
                        <>
                          <KTabs.Trigger
                            onClick={() =>
                              setBackgroundTab(
                                key as keyof typeof BACKGROUND_THEMES
                              )
                            }
                            value={key}
                            class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 text-gray-400 bg-transparent rounded-lg border transition-colors duration-300 ui-not-selected:hover:border-gray-300 ui-selected:bg-gray-200 group ui-selected:text-gray-500 disabled:opacity-50 focus:outline-none"
                          >
                            {value}
                          </KTabs.Trigger>
                        </>
                      )}
                    </For>
                  </KTabs.List>
                </KTabs>
                {/** End of Background Tabs */}
                <KRadioGroup
                  value={
                    project.background.source.type === "wallpaper"
                      ? wallpapers()?.find((w) =>
                          (
                            project.background.source as { path?: string }
                          ).path?.includes(w.id)
                        )?.url ?? undefined
                      : undefined
                  }
                  onChange={(photoUrl) => {
                    try {
                      const wallpaper = wallpapers()?.find(
                        (w) => w.url === photoUrl
                      );
                      if (!wallpaper) return;

                      // Get the raw path without any URL prefixes
                      const rawPath = decodeURIComponent(
                        photoUrl.replace("file://", "")
                      );

                      debouncedSetProject(wallpaper.rawPath);
                    } catch (err) {
                      toast.error("Failed to set wallpaper");
                    }
                  }}
                  class="grid grid-cols-7 gap-2 h-auto"
                >
                  <Show
                    when={!wallpapers.loading}
                    fallback={
                      <div class="flex col-span-7 justify-center items-center h-32 text-gray-400">
                        <div class="flex flex-col gap-2 items-center">
                          <div class="w-6 h-6 rounded-full border-2 border-gray-300 animate-spin border-t-blue-400" />
                          <span>Loading wallpapers...</span>
                        </div>
                      </div>
                    }
                  >
                    <For each={filteredWallpapers().slice(0, 21)}>
                      {(photo) => (
                        <KRadioGroup.Item
                          value={photo.url!}
                          class="relative aspect-square group"
                        >
                          <KRadioGroup.ItemInput class="peer" />
                          <KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg transition cursor-pointer ui-not-checked:ring-offset-1 ui-not-checked:ring-offset-gray-200 ui-not-checked:hover:ring-1 ui-not-checked:hover:ring-gray-400 ui-checked:ring-2 ui-checked:ring-gray-500 ui-checked:ring-offset-2 ui-checked:ring-offset-gray-200">
                            <img
                              src={photo.url!}
                              loading="eager"
                              class="object-cover w-full h-full"
                              alt="Wallpaper option"
                            />
                          </KRadioGroup.ItemControl>
                        </KRadioGroup.Item>
                      )}
                    </For>
                    <Show when={filteredWallpapers().length > 21}>
                      <Collapsible class="col-span-7">
                        <Collapsible.Trigger
                          class="flex gap-1 items-center px-2 py-2 w-full text-left text-gray-500 hover:text-gray-700"
                          onClick={() => {
                            if (!allWallpapersLoaded()) {
                              loadMoreWallpapers();
                            }
                          }}
                        >
                          <Show
                            when={!loadingMore()}
                            fallback={
                              <div class="flex gap-2 items-center">
                                <div class="w-4 h-4 rounded-full border-2 border-gray-300 animate-spin border-t-blue-400" />
                                <span>Loading more wallpapers...</span>
                              </div>
                            }
                          >
                            <div class="flex gap-1 items-center">
                              <span class="data-[expanded]:hidden">
                                Show more wallpapers
                              </span>
                              <span class="hidden data-[expanded]:inline">
                                Hide wallpapers
                              </span>
                              <IconCapChevronDown class="w-4 h-4 transition-transform ui-expanded:rotate-180" />
                            </div>
                          </Show>
                        </Collapsible.Trigger>
                        <Collapsible.Content class="animate-in slide-in-from-top-2 fade-in">
                          <div class="grid grid-cols-7 gap-2">
                            <For each={filteredWallpapers().slice(21)}>
                              {(photo) => (
                                <KRadioGroup.Item
                                  value={photo.url!}
                                  class="relative aspect-square group"
                                >
                                  <KRadioGroup.ItemInput class="peer" />
                                  <KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg border border-gray-200 cursor-pointer ui-checked:border-blue-300 ui-checked:ring-2 ui-checked:ring-blue-300 peer-focus-visible:border-2 peer-focus-visible:border-blue-300">
                                    <img
                                      src={photo.url!}
                                      alt="Wallpaper option"
                                      class="object-cover w-full h-full"
                                      loading="lazy"
                                    />
                                  </KRadioGroup.ItemControl>
                                </KRadioGroup.Item>
                              )}
                            </For>
                          </div>
                        </Collapsible.Content>
                      </Collapsible>
                    </Show>
                  </Show>
                </KRadioGroup>
              </KTabs.Content>
              <KTabs.Content value="image">
                <Show
                  when={
                    project.background.source.type === "image" &&
                    project.background.source.path
                  }
                  fallback={
                    <button
                      type="button"
                      onClick={() => fileInput.click()}
                      class="p-6 bg-gray-100 text-[13px] w-full rounded-[0.5rem] border border-gray-300 border-dashed flex flex-col items-center justify-center gap-[0.5rem] hover:bg-gray-200 transition-colors duration-100"
                    >
                      <IconCapImage class="text-gray-400 size-6" />
                      <span class="text-gray-500">
                        Click to select or drag and drop image
                      </span>
                    </button>
                  }
                >
                  {(source) => (
                    <div class="overflow-hidden relative w-full h-48 rounded-md border border-gray-200 group">
                      <img
                        src={convertFileSrc(source())}
                        class="object-cover w-full h-full"
                        alt="Selected background"
                      />
                      <div class="absolute top-2 right-2">
                        <button
                          type="button"
                          onClick={() =>
                            setProject("background", "source", {
                              type: "image",
                              path: null,
                            })
                          }
                          class="p-2 text-white rounded-full transition-colors bg-black/50 hover:bg-black/70"
                        >
                          <IconCapCircleX class="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <input
                  type="file"
                  ref={fileInput}
                  class="hidden"
                  accept="image/apng, image/avif, image/jpeg, image/png, image/webp"
                  onChange={async (e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;

                    /*
                    this is a Tauri bug in WebKit so we need to validate the file type manually
                    https://github.com/tauri-apps/tauri/issues/9158
                    */
                    const validExtensions = [
                      "jpg",
                      "jpeg",
                      "png",
                      "gif",
                      "webp",
                      "bmp",
                    ];
                    const extension = file.name.split(".").pop()?.toLowerCase();
                    if (!extension || !validExtensions.includes(extension)) {
                      toast.error("Invalid image file type");
                      return;
                    }

                    try {
                      const fileName = `bg-${Date.now()}-${file.name}`;
                      const arrayBuffer = await file.arrayBuffer();
                      const uint8Array = new Uint8Array(arrayBuffer);

                      const fullPath = `${await appDataDir()}/${fileName}`;

                      await writeFile(fileName, uint8Array, {
                        baseDir: BaseDirectory.AppData,
                      });

                      setProject("background", "source", {
                        type: "image",
                        path: fullPath,
                      });
                    } catch (err) {
                      toast.error("Failed to save image");
                    }
                  }}
                />
              </KTabs.Content>
              <KTabs.Content value="color">
                <Show
                  when={
                    project.background.source.type === "color" &&
                    project.background.source
                  }
                >
                  <div class="flex flex-col flex-wrap gap-4">
                    <RgbInput
                      value={
                        project.background.source.type === "color"
                          ? project.background.source.value
                          : [0, 0, 0]
                      }
                      onChange={(value) => {
                        setProject("background", "source", {
                          type: "color",
                          value,
                        });
                      }}
                    />

                    <div class="flex flex-wrap gap-2">
                      <For each={BACKGROUND_COLORS}>
                        {(color) => (
                          <label class="relative">
                            <input
                              type="radio"
                              class="sr-only peer"
                              name="colorPicker"
                              onChange={(e) => {
                                if (e.target.checked) {
                                  backgrounds.color = {
                                    type: "color",
                                    value: hexToRgb(color) ?? [0, 0, 0],
                                  };
                                  setProject(
                                    "background",
                                    "source",
                                    backgrounds.color
                                  );
                                }
                              }}
                            />
                            <div
                              class="rounded-lg transition-all duration-200 cursor-pointer size-6 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
                              style={{ "background-color": color }}
                            />
                          </label>
                        )}
                      </For>
                    </div>
                    {/* <Tooltip content="Add custom color">
                      <button
                        class="flex justify-center items-center w-6 h-6 text-gray-500 rounded-lg border border-gray-400 border-dashed hover:border-gray-500"
                        onClick={() => {
                          // Function to add a new color (you can modify this)
                          console.log(
                            "Open color picker or modal to add a color"
                          );
                        }}
                      >
                        +
                      </button>
                    </Tooltip> */}
                  </div>
                </Show>
              </KTabs.Content>
              <KTabs.Content
                value="gradient"
                class="flex flex-row justify-between"
              >
                <Show
                  when={
                    project.background.source.type === "gradient" &&
                    project.background.source
                  }
                >
                  {(source) => {
                    const max = 360;

                    const { history } = useEditorContext();

                    const angle = () => source().angle ?? 90;

                    return (
                      <>
                        <div class="flex flex-col gap-6">
                          <div class="flex gap-5">
                            <RgbInput
                              value={source().from}
                              onChange={(from) => {
                                backgrounds.gradient.from = from;
                                setProject("background", "source", {
                                  type: "gradient",
                                  from,
                                });
                              }}
                            />
                            <RgbInput
                              value={source().to}
                              onChange={(to) => {
                                backgrounds.gradient.to = to;
                                setProject("background", "source", {
                                  type: "gradient",
                                  to,
                                });
                              }}
                            />
                          </div>
                          <div class="flex flex-wrap gap-2">
                            <For each={BACKGROUND_GRADIENTS}>
                              {(gradient) => (
                                <label class="relative">
                                  <input
                                    type="radio"
                                    class="sr-only peer"
                                    name="colorPicker"
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        backgrounds.gradient = {
                                          type: "gradient",
                                          from: gradient.from,
                                          to: gradient.to,
                                        };
                                        setProject(
                                          "background",
                                          "source",
                                          backgrounds.gradient
                                        );
                                      }
                                    }}
                                  />
                                  <div
                                    class="rounded-lg transition-all duration-200 cursor-pointer size-6 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
                                    style={{
                                      background: `linear-gradient(${angle()}deg, rgb(${gradient.from.join(
                                        ","
                                      )}), rgb(${gradient.to.join(",")}))`,
                                    }}
                                  />
                                </label>
                              )}
                            </For>
                          </div>
                        </div>
                        <div
                          class="flex relative flex-col items-center p-1 bg-gray-50 rounded-full border border-gray-200 size-12 cursor-ns-resize shrink-0"
                          style={{ transform: `rotate(${angle()}deg)` }}
                          onMouseDown={(downEvent) => {
                            const start = angle();
                            const resumeHistory = history.pause();

                            createRoot((dispose) =>
                              createEventListenerMap(window, {
                                mouseup: () => dispose(),
                                mousemove: (moveEvent) => {
                                  const rawNewAngle =
                                    Math.round(
                                      start +
                                        (downEvent.clientY - moveEvent.clientY)
                                    ) % max;
                                  const newAngle = moveEvent.shiftKey
                                    ? rawNewAngle
                                    : Math.round(rawNewAngle / 45) * 45;

                                  if (
                                    !moveEvent.shiftKey &&
                                    hapticsEnabled() &&
                                    project.background.source.type ===
                                      "gradient"
                                  ) {
                                    if (previousAngle() !== newAngle) {
                                      commands.performHapticFeedback(
                                        "Alignment",
                                        "Now"
                                      );
                                    }
                                    setPreviousAngle(newAngle);
                                  }

                                  setProject("background", "source", {
                                    type: "gradient",
                                    angle:
                                      newAngle < 0 ? newAngle + max : newAngle,
                                  });
                                },
                              })
                            );
                          }}
                        >
                          <div class="bg-blue-300 rounded-full size-2" />
                        </div>
                      </>
                    );
                  }}
                </Show>
              </KTabs.Content>
            </KTabs>
          </Field>

          <Field name="Background Blur" icon={<IconCapBgBlur />}>
            <Slider
              value={[project.background.blur]}
              onChange={(v) => setProject("background", "blur", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          {/** Dashed divider */}
          <div class="w-full border-t border-gray-300 border-dashed" />
          <Field name="Padding" icon={<IconCapPadding class="size-4" />}>
            <Slider
              value={[project.background.padding]}
              onChange={(v) => setProject("background", "padding", v[0])}
              minValue={0}
              maxValue={40}
              step={0.1}
            />
          </Field>
          <Field
            name="Rounded Corners"
            icon={<IconCapCorners class="size-4" />}
          >
            <Slider
              value={[project.background.rounding]}
              onChange={(v) => setProject("background", "rounding", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          <Field name="Shadow" icon={<IconCapShadow class="size-4" />}>
            <Slider
              value={[project.background.shadow!]}
              onChange={(v) => {
                batch(() => {
                  setProject("background", "shadow", v[0]);
                  // Initialize advanced shadow settings if they don't exist and shadow is enabled
                  if (v[0] > 0 && !project.background.advancedShadow) {
                    setProject("background", "advancedShadow", {
                      size: 50,
                      opacity: 18,
                      blur: 50,
                    });
                  }
                });
              }}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
            <ShadowSettings
              scrollRef={scrollRef}
              size={{
                value: [project.background.advancedShadow?.size ?? 50],
                onChange: (v) => {
                  setProject("background", "advancedShadow", {
                    ...(project.background.advancedShadow ?? {
                      size: 50,
                      opacity: 18,
                      blur: 50,
                    }),
                    size: v[0],
                  });
                },
              }}
              opacity={{
                value: [project.background.advancedShadow?.opacity ?? 18],
                onChange: (v) => {
                  setProject("background", "advancedShadow", {
                    ...(project.background.advancedShadow ?? {
                      size: 50,
                      opacity: 18,
                      blur: 50,
                    }),
                    opacity: v[0],
                  });
                },
              }}
              blur={{
                value: [project.background.advancedShadow?.blur ?? 50],
                onChange: (v) => {
                  setProject("background", "advancedShadow", {
                    ...(project.background.advancedShadow ?? {
                      size: 50,
                      opacity: 18,
                      blur: 50,
                    }),
                    blur: v[0],
                  });
                },
              }}
            />
          </Field>
          {/* <ComingSoonTooltip>
            <Field name="Inset" icon={<IconCapInset />}>
              <Slider
                disabled
                value={[project.background.inset]}
                onChange={(v) => setProject("background", "inset", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
        </KTabs.Content>
        <KTabs.Content value="camera" class="flex flex-col gap-8">
          <Field icon={<IconCapCamera class="size-4" />} name="Camera">
            <div class="flex flex-col gap-8">
              <div>
                <Subfield name="Position" />
                <KRadioGroup
                  value={`${project.camera.position.x}:${project.camera.position.y}`}
                  onChange={(v) => {
                    const [x, y] = v.split(":");
                    setProject("camera", "position", { x, y } as any);
                  }}
                  class="mt-[0.75rem] rounded-[0.5rem] border border-gray-200 bg-gray-100 w-full h-[7.5rem] relative"
                >
                  <For
                    each={[
                      { x: "left", y: "top" } as const,
                      { x: "center", y: "top" } as const,
                      { x: "right", y: "top" } as const,
                      { x: "left", y: "bottom" } as const,
                      { x: "center", y: "bottom" } as const,
                      { x: "right", y: "bottom" } as const,
                    ]}
                  >
                    {(item) => (
                      <RadioGroup.Item value={`${item.x}:${item.y}`}>
                        <RadioGroup.ItemInput class="peer" />
                        <RadioGroup.ItemControl
                          class={cx(
                            "cursor-pointer size-6 shink-0 rounded-[0.375rem] bg-gray-300 absolute flex justify-center items-center ui-checked:bg-blue-300 focus-visible:outline peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-300 transition-colors duration-100",
                            item.x === "left"
                              ? "left-2"
                              : item.x === "right"
                              ? "right-2"
                              : "left-1/2 transform -translate-x-1/2",
                            item.y === "top" ? "top-2" : "bottom-2"
                          )}
                          onClick={() => setProject("camera", "position", item)}
                        >
                          <div class="size-[0.5rem] shrink-0 bg-white rounded-full" />
                        </RadioGroup.ItemControl>
                      </RadioGroup.Item>
                    )}
                  </For>
                </KRadioGroup>
              </div>
              <Subfield name="Hide Camera">
                <Toggle
                  checked={project.camera.hide}
                  onChange={(hide) => setProject("camera", "hide", hide)}
                />
              </Subfield>
              <Subfield name="Mirror Camera">
                <Toggle
                  checked={project.camera.mirror}
                  onChange={(mirror) => setProject("camera", "mirror", mirror)}
                />
              </Subfield>
            </div>
          </Field>
          {/** Dashed divider */}
          <div class="w-full border-t border-gray-300 border-dashed" />
          <Field
            name="Size"
            icon={<IconCapEnlarge class="size-4" />}
            value={`${project.camera.size}%`}
          >
            <Slider
              value={[project.camera.size]}
              onChange={(v) => setProject("camera", "size", v[0])}
              minValue={20}
              maxValue={80}
              step={0.1}
            />
          </Field>
          <Field
            name="Size During Zoom"
            icon={<IconCapEnlarge class="size-4" />}
            value={`${project.camera.zoom_size}%`}
          >
            <Slider
              value={[project.camera.zoom_size ?? 60]}
              onChange={(v) => setProject("camera", "zoom_size", v[0])}
              minValue={10}
              maxValue={60}
              step={0.1}
            />
          </Field>
          <Field
            name="Rounded Corners"
            icon={<IconCapCorners class="size-4" />}
          >
            <Slider
              value={[project.camera.rounding!]}
              onChange={(v) => setProject("camera", "rounding", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          <Field name="Shadow" icon={<IconCapShadow class="size-4" />}>
            <div class="space-y-8">
              <Slider
                value={[project.camera.shadow!]}
                onChange={(v) => setProject("camera", "shadow", v[0])}
                minValue={0}
                maxValue={100}
                step={0.1}
              />
              <ShadowSettings
                scrollRef={scrollRef}
                size={{
                  value: [project.camera.advanced_shadow?.size ?? 50],
                  onChange: (v) => {
                    setProject("camera", "advanced_shadow", {
                      ...(project.camera.advanced_shadow ?? {
                        size: 50,
                        opacity: 18,
                        blur: 50,
                      }),
                      size: v[0],
                    });
                  },
                }}
                opacity={{
                  value: [project.camera.advanced_shadow?.opacity ?? 18],
                  onChange: (v) => {
                    setProject("camera", "advanced_shadow", {
                      ...(project.camera.advanced_shadow ?? {
                        size: 50,
                        opacity: 18,
                        blur: 50,
                      }),
                      opacity: v[0],
                    });
                  },
                }}
                blur={{
                  value: [project.camera.advanced_shadow?.blur ?? 50],
                  onChange: (v) => {
                    setProject("camera", "advanced_shadow", {
                      ...(project.camera.advanced_shadow ?? {
                        size: 50,
                        opacity: 18,
                        blur: 50,
                      }),
                      blur: v[0],
                    });
                  },
                }}
              />
            </div>
          </Field>
          {/* <ComingSoonTooltip>
            <Field name="Shadow" icon={<IconCapShadow />}>
              <Slider
                disabled
                value={[project.camera.shadow]}
                onChange={(v) => setProject("camera", "shadow", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
        </KTabs.Content>
        <KTabs.Content value="transcript" class="flex flex-col gap-6">
          <Field name="Transcript" icon={<IconCapMessageBubble />}>
            <div class="p-1 text-gray-400 bg-gray-50 rounded-md border text-wrap">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ac
              purus sit amet nunc ultrices ultricies. Nullam nec scelerisque
              nunc. Nullam nec scelerisque nunc.
            </div>
            <button
              type="button"
              class="w-full bg-gray-400/20 hover:bg-gray-400/30 transition-colors duration-100 rounded-full py-1.5"
            >
              Edit
            </button>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="audio" class="flex flex-col gap-6">
          <Field name="Audio" icon={<IconCapAudioOn />}>
            <div class="flex flex-col gap-3">
              <Subfield name="Mute Audio">
                <Toggle
                  checked={project.audio.mute}
                  onChange={(v) => setProject("audio", "mute", v)}
                />
              </Subfield>
              {/* <ComingSoonTooltip>
                <Subfield name="Improve Mic Quality">
                  <Toggle disabled />
                </Subfield>
              </ComingSoonTooltip> */}
            </div>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="cursor" class="flex flex-col gap-6">
          {window.FLAGS.recordMouseState === true ? (
            <>
              <Field name="Cursor" icon={<IconCapCursor />}>
                <Subfield name="Hide cursor when not moving">
                  <Toggle
                    checked={project.cursor.hideWhenIdle}
                    onChange={(v) => setProject("cursor", "hideWhenIdle", v)}
                  />
                </Subfield>
              </Field>
              <Field name="Size" icon={<IconCapEnlarge />}>
                <Slider
                  value={[project.cursor.size]}
                  onChange={(v) => setProject("cursor", "size", v[0])}
                  minValue={20}
                  maxValue={300}
                  step={1}
                />
              </Field>
              <KCollapsible open={!project.cursor.raw}>
                <Field
                  name="Smooth Movement"
                  icon={<IconHugeiconsEaseCurveControlPoints />}
                  value={
                    <Toggle
                      checked={!project.cursor.raw}
                      onChange={(value) => {
                        setProject("cursor", "raw", !value);
                      }}
                    />
                  }
                />
                <KCollapsible.Content class="overflow-hidden border-b border-gray-200 opacity-0 transition-opacity animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
                  {/* if Content has padding or margin the animation doesn't look as good */}
                  <div class="flex flex-col gap-4 pt-4 pb-6">
                    <Field name="Tension">
                      <Slider
                        value={[project.cursor.tension]}
                        onChange={(v) => setProject("cursor", "tension", v[0])}
                        minValue={1}
                        maxValue={500}
                        step={1}
                      />
                    </Field>
                    <Field name="Friction">
                      <Slider
                        value={[project.cursor.friction]}
                        onChange={(v) => setProject("cursor", "friction", v[0])}
                        minValue={0}
                        maxValue={50}
                        step={0.1}
                      />
                    </Field>
                    <Field name="Mass">
                      <Slider
                        value={[project.cursor.mass]}
                        onChange={(v) => setProject("cursor", "mass", v[0])}
                        minValue={0.1}
                        maxValue={10}
                        step={0.01}
                      />
                    </Field>
                  </div>
                </KCollapsible.Content>
              </KCollapsible>

              {/* <Field name="Motion Blur">
                <Slider
                  value={[project.cursor.motionBlur]}
                  onChange={(v) => setProject("cursor", "motionBlur", v[0])}
                  minValue={0}
                  maxValue={1}
                  step={0.001}
                />
              </Field> */}
              {/* <Field name="Animation Style" icon={<IconLucideRabbit />}>
            <RadioGroup
              defaultValue="regular"
              value={project.cursor.animationStyle}
              onChange={(value) => {
                setProject(
                  "cursor",
                  "animationStyle",
                  value as CursorAnimationStyle
                );
              }}
              class="flex flex-col gap-2"
              disabled
            >
              {(
                Object.entries(CURSOR_ANIMATION_STYLES) as [
                  CursorAnimationStyle,
                  string
                ][]
              ).map(([value, label]) => (
                <RadioGroup.Item value={value} class="flex items-center">
                  <RadioGroup.ItemInput class="sr-only peer" />
                  <RadioGroup.ItemControl
                    class={cx(
                      "mr-2 w-4 h-4 rounded-full border border-gray-300",
                      "relative after:absolute after:inset-0 after:m-auto after:block after:w-2 after:h-2 after:rounded-full",
                      "after:transition-colors after:duration-200",
                      "peer-checked:border-blue-500 peer-checked:after:bg-blue-400",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/50",
                      "peer-disabled:opacity-50"
                    )}
                  />
                  <span
                    class={cx(
                      "text-gray-500",
                      "peer-checked:text-gray-900",
                      "peer-disabled:opacity-50"
                    )}
                  >
                    {label}
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup>
          </Field> */}
            </>
          ) : (
            <div class="flex flex-col gap-2 justify-center items-center p-4 text-gray-400">
              <IconCapCursor class="size-6" />
              <span>Cursor settings coming soon</span>
            </div>
          )}
        </KTabs.Content>
        <KTabs.Content value="captions" class="flex flex-col gap-6">
          <CaptionsTab />
        </KTabs.Content>
        <KTabs.Content value="hotkeys">
          <Field name="Hotkeys" icon={<IconCapHotkeys />}>
            <ComingSoonTooltip>
              <Subfield name="Show hotkeys">
                <Toggle disabled />
              </Subfield>
            </ComingSoonTooltip>
          </Field>
        </KTabs.Content>
      </div>
      <Show
        when={(() => {
          const selection =
            state.timelineSelection?.type === "zoom" && state.timelineSelection;
          if (!selection) return;

          const segment = project.timeline?.zoomSegments?.[selection.index];
          if (!segment) return;

          return { selection, segment };
        })()}
      >
        {(value) => {
          const zoomPercentage = () => {
            const amount = value().segment.amount;
            return `${amount.toFixed(1)}x`;
          };

          const zoomAmount = () => {
            const selection = state.timelineSelection;
            if (!selection || selection.type !== "zoom") return;

            const segment = project.timeline?.zoomSegments?.[selection.index];
            return segment?.amount;
          };

          return (
            <div
              data-visible={state.timelineSelection?.type === "zoom"}
              class="absolute inset-0 p-[0.75rem] text-[0.875rem] space-y-6 bg-gray-50 z-50 animate-in slide-in-from-bottom-2 fade-in"
            >
              <div class="flex flex-row justify-between items-center">
                <div class="flex gap-2 items-center">
                  <EditorButton
                    onClick={() => setState("timelineSelection", null)}
                    leftIcon={<IconLucideCheck />}
                  >
                    Done
                  </EditorButton>
                </div>
                <EditorButton
                  variant="danger"
                  onClick={() => {
                    const index = value().selection.index;

                    batch(() => {
                      setState("timelineSelection", null);
                      setProject(
                        "timeline",
                        "zoomSegments",
                        produce((s) => {
                          if (!s) return;
                          return s.splice(index, 1);
                        })
                      );
                    });
                  }}
                  leftIcon={<IconCapTrash />}
                >
                  Delete
                </EditorButton>
              </div>
              <Field
                name={`Zoom Amount (${zoomPercentage()})`}
                icon={<IconLucideSearch />}
              >
                <Slider
                  value={[value().segment.amount]}
                  onChange={(v) =>
                    setProject(
                      "timeline",
                      "zoomSegments",
                      value().selection.index,
                      "amount",
                      v[0]
                    )
                  }
                  minValue={1}
                  maxValue={4.5}
                  step={0.001}
                />
              </Field>
              <Field name="Zoom Mode" icon={<IconCapSettings />}>
                <KTabs class="space-y-6">
                  <KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
                    <KTabs.Trigger
                      value="auto"
                      class="z-10 flex-1 py-2.5 text-gray-400 transition-colors duration-100 outline-none ui-selected:text-gray-500 peer"
                      // onClick={() => setSelectedTab(item.id)}
                      disabled
                    >
                      Auto
                    </KTabs.Trigger>
                    <KTabs.Trigger
                      value="manual"
                      class="z-10 flex-1 py-2.5 text-gray-400 transition-colors duration-100 outline-none ui-selected:text-gray-500 peer"
                      // onClick={() => setSelectedTab(item.id)}
                    >
                      Manual
                    </KTabs.Trigger>
                    <KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden">
                      <div class="flex-1 bg-gray-100" />
                    </KTabs.Indicator>
                  </KTabs.List>
                  <KTabs.Content value="manual" tabIndex="">
                    <Show
                      when={(() => {
                        const m = value().segment.mode;
                        if (m === "auto") return;
                        return m.manual;
                      })()}
                    >
                      {(mode) => {
                        const start = createMemo<number>((prev) => {
                          if (history.isPaused()) return prev;
                          return value().segment.start;
                        }, 0);

                        const segmentIndex = createMemo<number>((prev) => {
                          if (history.isPaused()) return prev;

                          const st = start();
                          let i = project.timeline?.segments.findIndex(
                            (s) => s.start <= st && s.end > st
                          );
                          if (i === undefined || i === -1) return 0;
                          return i;
                        }, 0);

                        const video = document.createElement("video");
                        createEffect(() => {
                          video.src = convertFileSrc(
                            // TODO: this shouldn't be so hardcoded
                            `${
                              editorInstance.path
                            }/content/segments/segment-${segmentIndex()}/display.mp4`
                          );
                        });

                        createEffect(() => {
                          const s = start();
                          if (s === undefined) return;
                          video.currentTime = s;
                        });

                        createEffect(
                          on(
                            () => {
                              croppedPosition();
                              croppedSize();
                            },
                            () => {
                              render();
                            }
                          )
                        );

                        const render = () => {
                          const ctx = canvasRef.getContext("2d");
                          ctx!.imageSmoothingEnabled = false;
                          ctx!.drawImage(
                            video,
                            croppedPosition().x,
                            croppedPosition().y,
                            croppedSize().x,
                            croppedSize().y,
                            0,
                            0,
                            canvasRef.width!,
                            canvasRef.height!
                          );
                        };

                        const [loaded, setLoaded] = createSignal(false);
                        video.onloadeddata = () => {
                          setLoaded(true);
                          render();
                        };
                        video.onseeked = render;

                        let canvasRef!: HTMLCanvasElement;

                        const [ref, setRef] = createSignal<HTMLDivElement>();
                        const bounds = createElementBounds(ref);
                        const rawSize = () => {
                          const raw =
                            editorInstance.recordings.segments[0].display;
                          return { x: raw.width, y: raw.height };
                        };

                        const croppedPosition = () => {
                          const cropped = project.background.crop?.position;
                          if (cropped) return cropped;

                          return { x: 0, y: 0 };
                        };

                        const croppedSize = () => {
                          const cropped = project.background.crop?.size;
                          if (cropped) return cropped;

                          return rawSize();
                        };

                        const visualHeight = () =>
                          (bounds.width! / croppedSize().x) * croppedSize().y;

                        return (
                          <div
                            ref={setRef}
                            class="relative w-full"
                            style={{
                              height: `calc(${visualHeight()}px + 0.25rem)`,
                            }}
                            onMouseDown={(downEvent) => {
                              const bounds =
                                downEvent.currentTarget.getBoundingClientRect();

                              createRoot((dispose) => {
                                createEventListenerMap(window, {
                                  mouseup: () => dispose(),
                                  mousemove: (moveEvent) => {
                                    setProject(
                                      "timeline",
                                      "zoomSegments",
                                      value().selection.index,
                                      "mode",
                                      "manual",
                                      {
                                        x: Math.max(
                                          Math.min(
                                            (moveEvent.clientX - bounds.left) /
                                              bounds.width,
                                            1
                                          ),
                                          0
                                        ),
                                        y: Math.max(
                                          Math.min(
                                            (moveEvent.clientY - bounds.top) /
                                              bounds.height,
                                            1
                                          ),
                                          0
                                        ),
                                      }
                                    );
                                  },
                                });
                              });
                            }}
                          >
                            <div
                              class="absolute z-10 w-6 h-6 bg-gray-50 rounded-full border border-gray-400 -translate-x-1/2 -translate-y-1/2"
                              style={{
                                left: `calc(${mode().x * 100}% + ${
                                  2 + mode().x * -6
                                }px)`,
                                top: `calc(${mode().y * 100}% + ${
                                  2 + mode().y * -6
                                }px)`,
                              }}
                            />
                            <div class="overflow-hidden bg-gray-100 rounded-lg border border-gray-200">
                              <canvas
                                ref={canvasRef}
                                width={croppedSize().x}
                                height={croppedSize().y}
                                data-loaded={loaded()}
                                class="z-10 bg-red-500 opacity-0 transition-opacity data-[loaded='true']:opacity-100 w-full h-full duration-200"
                              />
                            </div>
                          </div>
                        );
                      }}
                    </Show>
                  </KTabs.Content>
                </KTabs>
              </Field>
            </div>
          );
        }}
      </Show>
    </KTabs>
  );
}

function RgbInput(props: {
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
  let prevHex = rgbToHex(props.value);

  let colorInput!: HTMLInputElement;

  return (
    <div class="flex flex-row items-center gap-[0.75rem] relative">
      <button
        type="button"
        class="size-[2rem] rounded-[0.5rem]"
        style={{
          "background-color": rgbToHex(props.value),
        }}
        onClick={() => colorInput.click()}
      />
      <input
        ref={colorInput}
        type="color"
        class="absolute left-0 bottom-0 w-[3rem] opacity-0"
        onChange={(e) => {
          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
        }}
      />
      <TextInput
        class="w-[4.60rem] p-[0.375rem] text-gray-500 text-[13px] border rounded-[0.5rem] bg-gray-50 outline-none focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
        value={text()}
        onFocus={() => {
          prevHex = rgbToHex(props.value);
        }}
        onInput={(e) => {
          setText(e.currentTarget.value);

          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
        }}
        onBlur={(e) => {
          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
          else {
            setText(prevHex);
            props.onChange(hexToRgb(text())!);
          }
        }}
      />
    </div>
  );
}

function rgbToHex(rgb: [number, number, number]) {
  return `#${rgb
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return null;
  return match.slice(1).map((c) => Number.parseInt(c, 16)) as any;
}
