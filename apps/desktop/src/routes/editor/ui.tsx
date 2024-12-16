import { Button } from "@cap/ui-solid";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Polymorphic, type PolymorphicProps } from "@kobalte/core/polymorphic";
import { Slider as KSlider } from "@kobalte/core/slider";
import { Switch as KSwitch } from "@kobalte/core/switch";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { cva, cx, type VariantProps } from "cva";
import {
  type ComponentProps,
  type JSX,
  type ParentProps,
  type ValidComponent,
  mergeProps,
  splitProps,
} from "solid-js";
import { useEditorContext } from "./context";

export function Field(
  props: ParentProps<{ name: string; icon?: JSX.Element }>
) {
  return (
    <div class="flex flex-col gap-[0.75rem]">
      <span class="flex flex-row items-center gap-[0.375rem] text-gray-500 text-[0.875rem]">
        {props.icon}
        {props.name}
      </span>
      {props.children}
    </div>
  );
}

export function Subfield(
  props: ParentProps<{ name: string; class?: string; required?: boolean }>
) {
  return (
    <div
      class={cx(
        "flex flex-row justify-between items-center text-gray-400",
        props.class
      )}
    >
      <span>
        {props.name}
        {props.required && <span class="text-blue-500 ml-px">*</span>}
      </span>
      {props.children}
    </div>
  );
}

export function Toggle(props: ComponentProps<typeof KSwitch>) {
  return (
    <KSwitch {...props}>
      <KSwitch.Input class="peer" />
      <KSwitch.Control class="rounded-full bg-gray-300 ui-disabled:bg-gray-200 w-[3rem] h-[1.5rem] p-[0.125rem] ui-checked:bg-blue-300 transition-colors peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-300">
        <KSwitch.Thumb class="bg-gray-50 rounded-full size-[1.25rem] transition-transform ui-checked:translate-x-[calc(100%+0.25rem)]" />
      </KSwitch.Control>
    </KSwitch>
  );
}

export function Slider(props: ComponentProps<typeof KSlider>) {
  const { history } = useEditorContext();

  // Pause history when slider is being dragged
  let resumeHistory: (() => void) | null = null;

  return (
    <KSlider
      {...props}
      class={cx("relative px-1 bg-gray-200 rounded-full", props.class)}
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
      <KSlider.Track class="h-[0.5rem] relative mx-1">
        <KSlider.Fill class="absolute bg-blue-100 ui-disabled:bg-gray-300 h-full rounded-full -ml-2" />
        <KSlider.Thumb
          class={cx(
            "size-[1.25rem] bg-blue-300 -top-1.5 rounded-full outline-none outline-2 outline-offset-2 focus-visible:outline-blue-300 ui-disabled:bg-gray-400"
          )}
        />
      </KSlider.Track>
    </KSlider>
  );
}

export function Input(props: ComponentProps<"input">) {
  return (
    <input
      {...props}
      class={cx(
        "rounded-[0.5rem] h-[2rem] p-[0.375rem] border w-full text-[0.875rem] focus:border-blue-300 outline-none",
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
    }
  ) {
    return (
      <KDialog {...props}>
        <KDialog.Portal>
          {!props.hideOverlay && (
            <KDialog.Overlay class="fixed inset-0 z-50 bg-[#000]/80 ui-expanded:animate-in ui-expanded:fade-in ui-closed:animate-out ui-closed:fade-out" />
          )}
          <div class="fixed inset-0 z-50 flex items-center justify-center">
            <KDialog.Content
              class={cx(
                "z-50 divide-y text-sm rounded-[1.25rem] overflow-hidden border border-gray-200 bg-gray-50 min-w-[22rem] ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 origin-top ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95",
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
  Footer(props: ComponentProps<"div">) {
    return (
      <div
        class={cx(
          "h-[3.5rem] px-[1rem] gap-[0.75rem] flex flex-row items-center justify-end",
          props.class
        )}
        {...props}
      >
        <Dialog.CloseButton />
        {props.children}
      </div>
    );
  },
  Header(props: ComponentProps<"div">) {
    return (
      <div {...props} class="h-[3.5rem] px-[1rem] flex flex-row items-center" />
    );
  },
  Content(props: ComponentProps<"div">) {
    return <div {...props} class={cx("p-[1rem] flex flex-col", props.class)} />;
  },
};

export function DialogContent(
  props: ParentProps<{ title: string; confirm: JSX.Element; class?: string }>
) {
  return (
    <>
      <Dialog.Header>
        <KDialog.Title class="text-gray-500 dark:text-gray-500">
          {props.title}
        </KDialog.Title>
      </Dialog.Header>
      <Dialog.Content class={props.class}>{props.children}</Dialog.Content>
      <Dialog.Footer>{props.confirm}</Dialog.Footer>
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
    "focus-visible:outline outline-2 outline-offset-2 transition-colors duration-100",
    "disabled:bg-gray-100 disabled:text-gray-400",
  ],
  {
    variants: {
      variant: {
        primary:
          "text-gray-500 enabled:hover:ui-not-pressed:bg-gray-100 ui-expanded:bg-gray-100 outline-blue-300",
        danger:
          "text-gray-500 enabled:hover:ui-not-pressed:bg-gray-100 ui-expanded:bg-red-300 ui-pressed:bg-red-300 ui-expanded:text-gray-50 ui-pressed:text-gray-50 outline-red-300",
      },
    },
    defaultVariants: { variant: "primary" },
  }
);

const editorButtonLeftIconStyles = cva("transition-colors duration-100", {
  variants: {
    variant: {
      primary:
        "text-gray-400 enabled:group-hover:not-ui-group-disabled:text-gray-500 ui-group-expanded:text-gray-500",
      danger:
        "text-gray-400 enabled:group-hover:text-gray-500 ui-group-expanded:text-gray-50 ui-group-pressed:text-gray-50",
    },
  },
  defaultVariants: { variant: "primary" },
});

type EditorButtonProps<T extends ValidComponent = "button"> =
  PolymorphicProps<T> & {
    leftIcon?: JSX.Element;
    rightIcon?: JSX.Element;
  } & VariantProps<typeof editorButtonStyles>;

export function EditorButton<T extends ValidComponent = "button">(
  props: EditorButtonProps<T>
) {
  const [local, cvaProps, others] = splitProps(
    mergeProps({ variant: "primary" }, props) as unknown as EditorButtonProps,
    ["children", "leftIcon", "rightIcon"],
    ["class", "variant"]
  );

  return (
    <Polymorphic
      as="button"
      {...others}
      class={editorButtonStyles({ ...cvaProps, class: cvaProps.class })}
    >
      <span class={editorButtonLeftIconStyles({ variant: cvaProps.variant })}>
        {local.leftIcon}
      </span>
      <span>{local.children}</span>
      <span class="text-gray-400">{local.rightIcon}</span>
    </Polymorphic>
  );
}

export const dropdownContainerClasses =
  "z-10 flex flex-col rounded-[0.75rem] border border-gray-200 bg-gray-50 shadow-s overflow-y-hidden outline-none";

export const topLeftAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-left";

export const topRightAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-right";

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
