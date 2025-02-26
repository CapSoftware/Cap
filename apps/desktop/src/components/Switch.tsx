import { JSX } from "solid-js";

interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  class?: string;
}

export function Switch(props: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      data-state={props.checked ? "checked" : "unchecked"}
      value={props.checked ? "on" : "off"}
      disabled={props.disabled}
      class={`peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
        props.checked
          ? "bg-blue-400 border-blue-400"
          : "bg-gray-300 border-gray-300"
      } ${props.class ?? ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span
        data-state={props.checked ? "checked" : "unchecked"}
        class={`pointer-events-none block h-4 w-4 rounded-full bg-gray-50 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 border-2 ${
          props.checked ? "border-blue-400" : "border-gray-300"
        }`}
      />
    </button>
  );
}
