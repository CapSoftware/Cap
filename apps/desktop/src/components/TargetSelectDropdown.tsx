import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/window";
import { cx } from "cva";
import { JSX, createEffect } from "solid-js";

function TargetSelect<T extends { id: number; name: string }>(props: {
  options: Array<T>;
  onChange: (value: T) => void;
  value: T | null;
  selected: boolean;
  class?: string;
  icon?: JSX.Element;
  areaSelectionPending?: boolean;
  isTargetCaptureArea?: boolean;
  optionsEmptyText: string;
  placeholder: string | JSX.Element;
}) {
  createEffect(() => {
    const v = props.value;
    if (!v) return;

    if (!props.options.some((o) => o.id === v.id)) {
      props.onChange(props.options[0] ?? null);
    }
  });

  async function showMenu(event: MouseEvent) {
    event.preventDefault();

    // Get the position of the clicked element
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();

    // Create the menu
    const menu = await Menu.new({
      items:
        props.options.length > 0
          ? props.options.map((option) => ({
              id: String(option.id),
              checked: option.id === props.value?.id,
              text: option.name,
              type: "checkbox",
              enabled: true,
              action: () => props.onChange(option),
            }))
          : [
              {
                text: props.optionsEmptyText,
                enabled: false,
              },
            ],
    });

    // Position the menu below the element using LogicalPosition
    const position = new LogicalPosition(
      Math.floor(rect.left),
      Math.floor(rect.bottom)
    );

    await menu.popup(position);
  }

  return (
    <button
      class={cx(
        "transition-shadow duration-200 text-black ",
        "data-[selected='false']:ring-0 data-[selected='false']:ring-transparent data-[selected='false']:ring-offset-0 ring-offset-zinc-50",
        props.areaSelectionPending || props.isTargetCaptureArea
          ? ""
          : "data-[selected='true']:ring-2 data-[selected='true']:ring-blue-300 data-[selected='true']:ring-offset-2",
        "flex overflow-hidden z-10 flex-col flex-1 gap-1 justify-center items-center px-2 py-1 w-full text-black transition-colors duration-100 peer focus:outline-none text-nowrap",
        props.class
      )}
      data-selected={props.selected}
      onClick={showMenu}
    >
      {props.icon}
      <span class="w-16 text-[13px] font-medium dark:text-white truncate transition-none">
        {props.value?.name || props.placeholder}
      </span>
    </button>
  );
}

export default TargetSelect;
