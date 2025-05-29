import { cx } from "cva";
import { JSX } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { RecordingMode } from "~/utils/tauri";
import InstantModeDark from "../assets/illustrations/instant-mode-dark.png";
import InstantModeLight from "../assets/illustrations/instant-mode-light.png";
import StudioModeDark from "../assets/illustrations/studio-mode-dark.png";
import StudioModeLight from "../assets/illustrations/studio-mode-light.png";

interface ModeOptionProps {
  mode: RecordingMode;
  title: string;
  description: string;
  icon: (props: { class: string }) => JSX.Element;
  isSelected: boolean;
  onSelect: (mode: RecordingMode) => void;
  darkimg: string;
  lightimg: string;
}

const ModeOption = (props: ModeOptionProps) => {
  return (
    <div
      onClick={() => props.onSelect(props.mode)}
      class={cx(`p-4 rounded-lg bg-gray-2 transition-all duration-200`, {
        "ring-2 ring-offset-2 hover:bg-gray-2 cursor-default ring-blue-9 ring-offset-gray-100":
          props.isSelected,
        "ring-2 ring-transparent ring-offset-transparent hover:bg-gray-3 cursor-pointer":
          !props.isSelected,
      })}
    >
      <div class="flex flex-col items-center mb-2 text-center">
        <img
          src={props.isSelected ? props.lightimg : props.darkimg}
          class="mb-6 w-full max-w-32"
        />
        <h3 class="text-lg font-medium text-gray-12">{props.title}</h3>
      </div>

      <p class={`mx-auto w-full text-sm text-gray-11 max-w-[300px]`}>
        {props.description}
      </p>
    </div>
  );
};

const ModeSelect = () => {
  const { rawOptions, setOptions } = createOptionsQuery();

  const handleModeChange = (mode: RecordingMode) => {
    setOptions({ mode });
  };

  const modeOptions = [
    {
      mode: "instant" as const,
      title: "Instant Mode",
      description:
        "Share your screen instantly with a magic link — no waiting for rendering, just capture and share in seconds.",
      icon: IconCapInstant,
      darkimg: InstantModeDark,
      lightimg: InstantModeLight,
    },
    {
      mode: "studio" as const,
      title: "Studio Mode",
      description:
        "Records at the highest quality/framerate. Captures both your screen and camera separately for editing later.",
      icon: IconCapFilmCut,
      darkimg: StudioModeDark,
      lightimg: StudioModeLight,
    },
  ];

  return (
    <div class="grid grid-cols-2 gap-8 text-center">
      {modeOptions.map((option) => (
        <ModeOption
          mode={option.mode}
          title={option.title}
          description={option.description}
          darkimg={option.darkimg}
          lightimg={option.lightimg}
          icon={option.icon}
          isSelected={rawOptions.mode === option.mode}
          onSelect={handleModeChange}
        />
      ))}
    </div>
  );
};

export default ModeSelect;
