import { Button } from "@cap/ui-solid";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Polymorphic, type PolymorphicProps } from "@kobalte/core/polymorphic";
import { Slider as KSlider } from "@kobalte/core/slider";
import { Switch as KSwitch } from "@kobalte/core/switch";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { cva, cx, type VariantProps } from "cva";

import {
  createRoot,
  createSignal,
  mergeProps,
  splitProps,
  type ComponentProps,
  type JSX,
  type ParentProps,
  type ValidComponent,
} from "solid-js";
import Tooltip from "~/components/Tooltip";
import { useEditorContext } from "./context";
import { TextInput } from "./TextInput";

export function Field(
  props: ParentProps<{ name: string; icon?: JSX.Element; value?: JSX.Element }>
) {
  return (
    <div class="flex flex-col gap-4">
      <span class="flex flex-row items-center gap-[0.375rem] text-gray-500 font-medium text-sm">
        {props.icon}
        {props.name}
        {props.value && <div class="ml-auto">{props.value}</div>}
      </span>
      {props.children}
    </div>
  );
}

export function Subfield(
  props: ParentProps<{ name: string; class?: string; required?: boolean }>
) {
  return (
    <div class={cx("flex flex-row justify-between items-center", props.class)}>
      <span class="font-medium text-gray-500">
        {props.name}
        {props.required && (
          <span class="ml-[2px] text-xs text-blue-500">*</span>
        )}
      </span>
      {props.children}
    </div>
  );
}

export function Toggle(props: ComponentProps<typeof KSwitch>) {
  return (
    <KSwitch {...props}>
      <KSwitch.Input class="peer" />
      <KSwitch.Control class="rounded-full bg-gray-300 ui-disabled:bg-gray-200 w-11 h-[1.5rem] p-[0.125rem] ui-checked:bg-blue-300 transition-colors peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-300">
        <KSwitch.Thumb class="bg-solid-white rounded-full size-[1.25rem] transition-transform ui-checked:translate-x-[calc(100%)]" />
      </KSwitch.Control>
    </KSwitch>
  );
}

export function Slider(
  props: ComponentProps<typeof KSlider> & {
    formatTooltip?: string | ((v: number) => string);
  }
) {
  const { projectHistory: history } = useEditorContext();

  // Pause history when slider is being dragged
  let resumeHistory: (() => void) | null = null;

  const [thumbRef, setThumbRef] = createSignal<HTMLDivElement>();

  const thumbBounds = createElementBounds(thumbRef);

  const [dragging, setDragging] = createSignal(false);

  return (
    <KSlider
      {...props}
      class={cx(
        "relative px-1 h-8 flex flex-row justify-stretch items-center",
        props.class
      )}
      onChange={(v) => {
        if (!resumeHistory) resumeHistory = history.pause();
        props.onChange?.(v);
      }}
      onChangeEnd={(e) => {
        resumeHistory?.();
        resumeHistory = null;
        props.onChangeEnd?.(e);
      }}
    >
      <KSlider.Track
        class="h-[0.3rem] cursor-pointer transition-[height] relative mx-1 bg-gray-200 rounded-full w-full before:content-[''] before:absolute before:inset-0 before:-top-3 before:-bottom-3"
        onPointerDown={() => {
          setDragging(true);
          createRoot((dispose) => {
            createEventListener(window, "mouseup", () => {
              setDragging(false);
              dispose();
            });
          });
        }}
      >
        <KSlider.Fill class="absolute -ml-2 h-full bg-blue-300 rounded-full ui-disabled:bg-gray-300" />
        <Tooltip
          open={dragging() ? true : undefined}
          getAnchorRect={() => {
            return {
              x: thumbBounds.left ?? undefined,
              y: thumbBounds.top ?? undefined,
              width: thumbBounds.width ?? undefined,
              height: thumbBounds.height ?? undefined,
            };
          }}
          content={
            props.value?.[0] !== undefined
              ? typeof props.formatTooltip === "string"
                ? `${props.value[0].toFixed(1)}${props.formatTooltip}`
                : props.formatTooltip
                ? props.formatTooltip(props.value[0])
                : props.value[0].toFixed(1)
              : undefined
          }
        >
          <KSlider.Thumb
            ref={setThumbRef}
            onPointerDown={() => {
              setDragging(true);
            }}
            onPointerUp={() => {
              setDragging(false);
            }}
            class={cx(
              "bg-solid-white shadow-xl border border-gray-300 rounded-full outline-none size-4 -top-[6.3px] ui-disabled:bg-gray-400 after:content-[''] after:absolute after:inset-0 after:-m-3 after:cursor-pointer"
            )}
          />
        </Tooltip>
      </KSlider.Track>
    </KSlider>
  );
}

export function Input(props: ComponentProps<"input">) {
  return (
    <TextInput
      {...props}
      class={cx(
        "rounded-[0.5rem] bg-gray-50 border-gray-200 hover:ring-1 py-[18px] hover:ring-gray-300 h-[2rem] font-normal placeholder:text-black-transparent-40 text-xs caret-gray-500 transition-shadow duration-200 focus:ring-offset-1 focus:ring-offset-gray-100 focus:ring-1 focus:ring-gray-500 px-[0.5rem] border w-full text-[0.875rem] outline-none text-gray-500",
        props.class
      )}
    />
  );
}

export const Dialog = {
  Root(
    props: ComponentProps<typeof KDialog> & {
      hideOverlay?: boolean;
      size?: "sm" | "lg";
      contentClass?: string;
    }
  ) {
    return (
      <KDialog {...props}>
        <KDialog.Portal>
          {!props.hideOverlay && (
            <KDialog.Overlay class="fixed inset-0 z-50 bg-[#000]/80 ui-expanded:animate-in ui-expanded:fade-in ui-closed:animate-out ui-closed:fade-out" />
          )}
          <div class="flex fixed inset-0 z-50 justify-center items-center">
            <KDialog.Content
              class={cx(
                props.contentClass,
                "z-50 text-sm rounded-[1.25rem] overflow-hidden border border-gray-200 bg-gray-50 min-w-[22rem] ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 origin-top ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95",
                (props.size ?? "sm") === "sm" ? "max-w-96" : "max-w-3xl"
              )}
            >
              {props.children}
            </KDialog.Content>
          </div>
        </KDialog.Portal>
      </KDialog>
    );
  },
  CloseButton() {
    return (
      <KDialog.CloseButton as={Button} variant="secondary">
        Cancel
      </KDialog.CloseButton>
    );
  },
  ConfirmButton(_props: ComponentProps<typeof Button>) {
    const props = mergeProps(
      { variant: "primary" } as ComponentProps<typeof Button>,
      _props
    );
    return <Button {...props} />;
  },
  Footer(
    props: ComponentProps<"div"> & {
      close?: JSX.Element;
      leftFooterContent?: JSX.Element;
    }
  ) {
    return (
      <div
        class={cx(
          "h-[4rem] px-[1rem] gap-3 flex flex-row items-center",
          props.leftFooterContent ? "justify-between" : "justify-center",
          props.class
        )}
        {...props}
      >
        {props.leftFooterContent}
        <div class="flex flex-row gap-3 items-center">{props.children}</div>
      </div>
    );
  },
  Header(props: ComponentProps<"div">) {
    return (
      <div {...props} class="h-[3.5rem] px-[1rem] flex flex-row items-center" />
    );
  },
  Content(props: ComponentProps<"div">) {
    return (
      <div
        {...props}
        class={cx(
          "p-[1rem] flex flex-col border-y border-gray-200",
          props.class
        )}
      />
    );
  },
};

export function DialogContent(
  props: ParentProps<{
    title: string;
    confirm: JSX.Element;
    class?: string;
    close?: JSX.Element;
    leftFooterContent?: JSX.Element;
  }>
) {
  return (
    <>
      <Dialog.Header>
        <KDialog.Title class="text-gray-500 dark:text-gray-500">
          {props.title}
        </KDialog.Title>
      </Dialog.Header>
      <Dialog.Content class={props.class}>{props.children}</Dialog.Content>
      <Dialog.Footer
        close={props.close}
        leftFooterContent={props.leftFooterContent}
      >
        {props.confirm}
      </Dialog.Footer>
    </>
  );
}

export function MenuItem<T extends ValidComponent = "button">(
  _props: ComponentProps<T>
) {
  const props = mergeProps({ as: "div" } as ComponentProps<T>, _props);

  return (
    <Polymorphic
      {...props}
      class={cx(
        props.class,
        "flex flex-row shrink-0 items-center gap-[0.375rem] px-[0.675rem] py-[0.375rem] rounded-[0.5rem] outline-none text-nowrap overflow-hidden text-ellipsis w-full max-w-full",
        "text-[0.875rem] text-gray-400 disabled:text-gray-400 ui-highlighted:bg-gray-100 ui-highlighted:text-gray-500"
      )}
    />
  );
}

export function DropdownItem(props: ComponentProps<typeof DropdownMenu.Item>) {
  return (
    <MenuItem<typeof DropdownMenu.Item> as={DropdownMenu.Item} {...props} />
  );
}

export function PopperContent<T extends ValidComponent = "div">(
  props: ComponentProps<T>
) {
  return (
    <Polymorphic {...props} class={cx(dropdownContainerClasses, props.class)} />
  );
}

export function MenuItemList<T extends ValidComponent = "div">(
  _props: ComponentProps<T>
) {
  const props = mergeProps({ as: "div" } as ComponentProps<T>, _props);

  return (
    <Polymorphic
      {...props}
      class={cx(
        props.class,
        "space-y-[0.375rem] p-[0.375rem] overflow-y-auto outline-none"
      )}
    />
  );
}

const editorButtonStyles = cva(
  [
    "group flex flex-row items-center px-[0.375rem] gap-[0.375rem] h-[2rem] rounded-[0.5rem] text-[0.875rem]",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-colors duration-100",
    "disabled:opacity-50 disabled:text-gray-400",
  ],
  {
    variants: {
      variant: {
        primary:
          "text-gray-500 enabled:hover:ui-not-pressed:bg-white-transparent-80 dark:enabled:hover:ui-not-pressed:bg-black-transparent-20 ui-expanded:bg-white-transparent-80 dark:ui-expanded:bg-black-transparent-20 dark:ui-expanded:bg-black-transparent-10 outline-blue-300 focus:bg-white-transparent-80 dark:focus:bg-black-transparent-20",
        danger:
          "text-gray-500 enabled:hover:ui-not-pressed:bg-white-transparent-80 dark:enabled:hover:ui-not-pressed:bg-black-transparent-20 ui-expanded:bg-red-300  ui-pressed:bg-red-300 ui-expanded:text-gray-50 ui-pressed:text-gray-50 outline-red-300",
      },
    },
    defaultVariants: { variant: "primary" },
  }
);

const editorButtonLeftIconStyles = cva("transition-colors duration-100", {
  variants: {
    variant: {
      primary:
        "text-gray-500 enabled:group-hover:not-ui-group-disabled:text-gray-500 ui-group-expanded:text-gray-500",
      danger:
        "text-gray-500 enabled:group-hover:text-gray-500 ui-group-expanded:text-gray-50 ui-group-pressed:text-gray-50",
    },
  },
  defaultVariants: { variant: "primary" },
});

type EditorButtonProps<T extends ValidComponent = "button"> =
  PolymorphicProps<T> & {
    children?: JSX.Element | string;
    leftIcon?: JSX.Element;
    rightIcon?: JSX.Element;
    tooltipText?: string;
    comingSoon?: boolean;
    rightIconEnd?: boolean;
  } & VariantProps<typeof editorButtonStyles>;

export function EditorButton<T extends ValidComponent = "button">(
  props: EditorButtonProps<T>
) {
  const [local, cvaProps, others] = splitProps(
    mergeProps({ variant: "primary" }, props) as unknown as EditorButtonProps,
    [
      "children",
      "leftIcon",
      "rightIcon",
      "tooltipText",
      "comingSoon",
      "rightIconEnd",
    ],
    ["class", "variant"]
  );

  const buttonContent = (
    <>
      <span class={editorButtonLeftIconStyles({ variant: cvaProps.variant })}>
        {local.leftIcon}
      </span>
      {local.children && <span>{local.children}</span>}
      {local.rightIcon && (
        <span class={local.rightIconEnd ? "ml-auto" : ""}>
          {local.rightIcon}
        </span>
      )}
    </>
  );

  return (
    <>
      {local.tooltipText || local.comingSoon ? (
        <Tooltip content={local.comingSoon ? "Coming Soon" : local.tooltipText}>
          <Polymorphic
            as="button"
            {...others}
            class={cx(
              editorButtonStyles({ ...cvaProps, class: cvaProps.class }),
              local.rightIconEnd && "justify-between"
            )}
            disabled={local.comingSoon}
          >
            {buttonContent}
          </Polymorphic>
        </Tooltip>
      ) : (
        <Polymorphic
          as="button"
          {...others}
          class={cx(
            editorButtonStyles({ ...cvaProps, class: cvaProps.class }),
            local.rightIconEnd && "justify-between"
          )}
        >
          {buttonContent}
        </Polymorphic>
      )}
    </>
  );
}

export const dropdownContainerClasses =
  "z-10 flex flex-col rounded-[0.75rem] border border-gray-200 bg-gray-50 shadow-s overflow-y-hidden outline-none";

export const topLeftAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-left";

export const topCenterAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-center";

export const topRightAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-right";

export const topSlideAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:slide-in-from-top-1 ui-closed:animate-out ui-closed:fade-out ui-closed:slide-out-to-top-1 origin-top-center";

export function ComingSoonTooltip(
  props: ComponentProps<typeof KTooltip> & any
) {
  const [trigger, root] = splitProps(props, ["children", "as"]);
  return (
    <KTooltip placement="top" openDelay={0} closeDelay={0} {...root}>
      <KTooltip.Trigger as={trigger.as ?? "div"}>
        {trigger.children}
      </KTooltip.Trigger>
      <KTooltip.Portal>
        <KTooltip.Content class="p-2 font-medium bg-gray-500 dark:bg-gray-700 text-gray-50 ui-expanded:animate-in ui-expanded:slide-in-from-bottom-1 ui-expanded:fade-in ui-closed:animate-out ui-closed:slide-out-to-bottom-1 ui-closed:fade-out rounded-lg text-xs z-[1000]">
          Coming Soon
        </KTooltip.Content>
      </KTooltip.Portal>
    </KTooltip>
  );
}
