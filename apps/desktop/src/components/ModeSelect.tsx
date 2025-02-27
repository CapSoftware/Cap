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
      class={`p-4 rounded-lg bg-gray-100 transition-all duration-200  ${
        props.isSelected
          ? "ring-2 ring-offset-2 hover:bg-gray-100 cursor-default ring-blue-300 ring-offset-gray-100"
          : "ring-2 ring-transparent ring-offset-transparent hover:bg-gray-200 cursor-pointer"
      }`}
    >
      <div class="flex flex-col items-center mb-2 text-center">
        {/* <props.icon
          class={`size-8 mb-2 ${
            props.isSelected ? "text-gray-50" : "text-[--gray-500]"
          }`}
        /> */}
        <img
          src={props.isSelected ? props.lightimg : props.darkimg}
          class="mb-6 w-full max-w-32"
        />
        <h3
          class={`text-lg font-medium ${
            props.isSelected ? "text-gray-500" : "text-gray-500"
          }`}
        >
          {props.title}
        </h3>
      </div>

      <p
        class={`mx-auto w-full text-sm text-gray-400 dark:text-gray-400 max-w-[300px]`}
      >
        {props.description}
      </p>
    </div>
  );
};

const ModeSelect = () => {
  const { options, setOptions } = createOptionsQuery();

  const handleModeChange = (mode: RecordingMode) => {
    if (!options.data) return;
    setOptions.mutate({ ...options.data, mode });
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
          isSelected={options.data?.mode === option.mode}
          onSelect={handleModeChange}
        />
      ))}
    </div>
  );
};

export default ModeSelect;
