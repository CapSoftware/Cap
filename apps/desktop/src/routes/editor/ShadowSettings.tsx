import { Collapsible } from "@kobalte/core/collapsible";

import { Slider } from "./ui";

interface Props {
  size: {
    value: any[];
    onChange: (v: number[]) => void;
  };
  opacity: {
    value: any[];
    onChange: (v: number[]) => void;
  };
  blur: {
    value: any[];
    onChange: (v: number[]) => void;
  };
  scrollRef?: HTMLDivElement;
}

const ShadowSettings = ({ size, opacity, blur, scrollRef }: Props) => {
  return (
    <Collapsible>
      <Collapsible.Trigger
        onClick={() => {
          if (!scrollRef) return;
          setTimeout(() => {
            scrollRef.scrollTo({
              top: scrollRef.scrollHeight,
              behavior: "smooth",
            });
          }, 50);
        }}
        class="flex gap-1 items-center w-full font-medium text-left text-gray-500 hover:text-gray-700"
      >
        Advanced shadow settings
        <IconCapChevronDown class="w-4 h-4 transition-transform aria-expanded:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content class="mt-4 space-y-8 font-medium animate-in slide-in-from-top-2 fade-in">
        <div class="flex flex-col gap-6">
          <span class="text-sm text-gray-500">Size</span>
          <Slider
            value={size.value}
            onChange={size.onChange}
            minValue={0}
            maxValue={100}
            step={0.1}
          />
        </div>
        <div class="flex flex-col gap-6">
          <span class="text-sm text-gray-500">Opacity</span>
          <Slider
            value={opacity.value}
            onChange={opacity.onChange}
            minValue={0}
            maxValue={100}
            step={0.1}
          />
        </div>
        <div class="flex flex-col gap-6">
          <span class="text-sm text-gray-500">Blur</span>
          <Slider
            value={blur.value}
            onChange={blur.onChange}
            minValue={0}
            maxValue={100}
            step={0.1}
          />
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
};

export default ShadowSettings;
