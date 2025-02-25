import { Select as KSelect, SelectRootProps } from "@kobalte/core/select";
import { cx } from "cva";
import { JSX, Show, type ValidComponent, createEffect } from "solid-js";

import { CaptureScreen } from "~/utils/tauri";
import {
  MenuItem,
  MenuItemList,
  PopperContent,
  topRightAnimateClasses,
} from "../routes/editor/ui";

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
  itemComponent?: (
    props: Parameters<
      NonNullable<SelectRootProps<T | null>["itemComponent"]>
    >[0]
  ) => JSX.Element;
}) {
  createEffect(() => {
    const v = props.value;
    if (!v) return;

    if (!props.options.some((o) => o.id === v.id)) {
      props.onChange(props.options[0] ?? null);
    }
  });

  return (
    <KSelect<T | null>
      options={props.options ?? []}
      optionValue="id"
      optionTextValue="name"
      gutter={8}
      itemComponent={(itemProps) => (
        <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={itemProps.item}>
          {/* <KSelect.ItemLabel class="flex-1"> */}
          {props?.itemComponent?.(itemProps) ?? itemProps.item.rawValue?.name}
          {/* </KSelect.ItemLabel> */}
        </MenuItem>
      )}
      placement="bottom"
      data-selected={props.selected}
      class={cx(
        "transition-all duration-200 text-black",
        "data-[selected='false']:ring-0 data-[selected='false']:ring-transparent data-[selected='false']:ring-offset-0 ring-offset-zinc-50",
        props.areaSelectionPending || props.isTargetCaptureArea
          ? ""
          : "data-[selected='true']:ring-2 data-[selected='true']:ring-blue-300 data-[selected='true']:ring-offset-2",
        props.class
      )}
      placeholder={props.placeholder}
      onChange={(value) => {
        if (!value) return;
        props.onChange(value);
      }}
      value={props.value}
    >
      <KSelect.Trigger<ValidComponent>
        as={
          props.options.length <= 1
            ? (p) => (
                <button
                  onClick={() => {
                    props.onChange(props.options[0]);
                  }}
                  data-selected={props.selected}
                  class={p.class}
                >
                  {props.icon}
                  <span class="truncate">{props.placeholder}</span>
                </button>
              )
            : undefined
        }
        class="flex overflow-hidden z-10 flex-col flex-1 gap-1 justify-center items-center px-2 py-1 w-full text-black transition-colors duration-100 peer focus:outline-none text-nowrap"
        data-selected={props.selected}
        onClick={(e) => {
          if (props.options.length === 1) {
            e.preventDefault();
            props.onChange(props.options[0]);
          }
        }}
      >
        {props.icon}
        <KSelect.Value<
          CaptureScreen | undefined
        > class="w-16 text-[13px] font-medium dark:text-white truncate transition-none">
          {(value) => value.selectedOption()?.name}
        </KSelect.Value>
        {/* {props.options.length > 1 && (
          <KSelect.Icon class="transition-transform ui-expanded:-rotate-180">
            <IconCapChevronDown class="transition-transform transform size-4 shrink-0" />
          </KSelect.Icon>
        )} */}
      </KSelect.Trigger>
      <KSelect.Portal>
        <PopperContent<typeof KSelect.Content>
          as={KSelect.Content}
          class={topRightAnimateClasses}
        >
          <Show
            when={props.options.length > 0}
            fallback={
              <div class="p-2 text-gray-500 text-[13px]">
                {props.optionsEmptyText}
              </div>
            }
          >
            <KSelect.Listbox class="max-h-52 max-w-[17rem]" as={MenuItemList} />
          </Show>
        </PopperContent>
      </KSelect.Portal>
    </KSelect>
  );
}

export default TargetSelect;
