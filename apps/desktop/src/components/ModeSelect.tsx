import { JSX } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { RecordingMode } from "~/utils/tauri";

interface ModeOptionProps {
  mode: RecordingMode;
  title: string;
  description: string;
  icon: (props: { class: string }) => JSX.Element;
  isSelected: boolean;
  onSelect: (mode: RecordingMode) => void;
}

const ModeOption = (props: ModeOptionProps) => {
  return (
    <div
      onClick={() => props.onSelect(props.mode)}
      class={`p-4 rounded-lg transition-colors cursor-pointer border-2 ${
        props.isSelected
          ? "border-blue-200 bg-[--gray-50] shadow-[0_0_180px_rgba(0,0,0,0.18)]"
          : "border-transparent"
      }`}
    >
      <div class="flex flex-col items-center text-center mb-2">
        {/* <props.icon
          class={`size-8 mb-2 ${
            props.isSelected
              ? "text-[--gray-50]"
              : "text-[--gray-500] dark:text-[--gray-50]"
          }`}
        /> */}
        <h3
          class={`text-lg font-medium ${
            props.isSelected
              ? "text-[--gray-500]"
              : "text-[--gray-500] dark:text-[--gray-50]"
          }`}
        >
          {props.title}
        </h3>
      </div>

      <p
        class={`text-sm ${
          props.isSelected
            ? "text-[--gray-500]"
            : "text-[--gray-500] dark:text-[--gray-50]"
        }`}
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
    },
    {
      mode: "studio" as const,
      title: "Studio Mode",
      description:
        "Records at the highest quality/framerate. Captures both your screen and camera separately for editing later.",
      icon: IconCapFilmCut,
    },
  ];

  return (
    <div class="p-6">
      <div class="grid grid-cols-2 gap-6 text-center">
        {modeOptions.map((option) => (
          <ModeOption
            mode={option.mode}
            title={option.title}
            description={option.description}
            icon={option.icon}
            isSelected={options.data?.mode === option.mode}
            onSelect={handleModeChange}
          />
        ))}
      </div>
    </div>
  );
};

export default ModeSelect;
