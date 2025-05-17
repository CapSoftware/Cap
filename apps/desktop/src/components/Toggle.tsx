import { Switch as KSwitch } from "@kobalte/core/switch";
import { cva, type VariantProps } from "cva";
import { splitProps, type ComponentProps } from "solid-js";

const toggleControlStyles = cva(
  "rounded-full bg-gray-5 ui-disabled:bg-gray-3 ui-checked:bg-blue-9 transition-colors outline-2 outline-offset-2 outline-blue-300",
  {
    variants: {
      size: {
        sm: "w-9 h-[1.25rem] p-[0.125rem]",
        md: "w-11 h-[1.5rem] p-[0.125rem]",
        lg: "w-14 h-[1.75rem] p-[0.1875rem]"
      }
    },
    defaultVariants: {
      size: "md"
    }
  }
);

const toggleThumbStyles = cva(
  "ui-checked:bg-solid-white bg-gray-10 rounded-full transition-transform ui-checked:translate-x-[calc(100%)]",
  {
    variants: {
      size: {
        sm: "size-[1rem]",
        md: "size-[1.25rem]",
        lg: "size-[1.5rem]"
      }
    },
    defaultVariants: {
      size: "md"
    }
  }
);

export function Toggle(props: ComponentProps<typeof KSwitch> & { size?: 'sm' | 'md' | 'lg' }) {
  const [local, others] = splitProps(props, ['size']);
  
  return (
    <KSwitch {...others}>
      <KSwitch.Input class="peer" />
      <KSwitch.Control class={toggleControlStyles({ size: local.size })}>
        <KSwitch.Thumb class={toggleThumbStyles({ size: local.size })} />
      </KSwitch.Control>
    </KSwitch>
  );
}
