import { Toggle } from "~/components/Toggle";

export function Setting(props: {
  pro?: boolean;
  label: string;
  description?: string;
  children: any;
}) {
  return (
    <div class="flex flex-row gap-2 justify-between items-start py-3 text-sm">
      <div class="flex flex-col justify-between items-start space-y-2">
        {props.pro && (
          <span class="px-2 py-1 text-xs font-medium rounded-lg text-solid-white bg-blue-9">
            Cap Pro
          </span>
        )}
        <div class="flex gap-2 items-center">
          <p class="text-gray-12">{props.label}</p>
        </div>
        {props.description && (
          <p class="text-xs text-gray-11">{props.description}</p>
        )}
      </div>
      {props.children}
    </div>
  );
}

export function ToggleSetting(props: {
  pro?: boolean;
  label: string;
  description?: string;
  value: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <Setting {...props}>
      <Toggle
        size="sm"
        checked={props.value}
        onChange={(v) => props.onChange(v)}
      />
    </Setting>
  );
}
