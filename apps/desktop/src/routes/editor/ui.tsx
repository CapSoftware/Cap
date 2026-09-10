import { Button } from "@cap/ui-solid";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Polymorphic, type PolymorphicProps } from "@kobalte/core/polymorphic";
import { Slider as KSlider } from "@kobalte/core/slider";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { cva, cx, type VariantProps } from "cva";

import {
	type ComponentProps,
	children,
	createRoot,
	createSignal,
	type JSX,
	mergeProps,
	type ParentProps,
	Show,
	splitProps,
	type ValidComponent,
} from "solid-js";
import Tooltip from "~/components/Tooltip";
import { useEditorContext } from "./context";
import { TextInput } from "./TextInput";

export function Section(
	props: ParentProps<{ name: string; action?: JSX.Element; class?: string }>,
) {
	return (
		<div class={cx("flex flex-col gap-2.5", props.class)}>
			<div class="flex flex-row gap-2 items-center min-h-[22px]">
				<SectionLabel name={props.name} />
				<Show when={props.action}>
					<div class="ml-auto flex flex-row gap-1 items-center">
						{props.action}
					</div>
				</Show>
			</div>
			{props.children}
		</div>
	);
}

export function SectionLabel(props: { name: string; class?: string }) {
	return (
		<span class={cx("text-[12px] font-medium text-ed-text-2", props.class)}>
			{props.name}
		</span>
	);
}

function FieldLabel(props: {
	name: string;
	badge?: string;
	disabled?: boolean;
	icon?: JSX.Element;
	class?: string;
}) {
	return (
		<span
			data-disabled={props.disabled}
			class={cx(
				"flex flex-row items-center gap-1.5 text-[13px] font-normal text-ed-text-1 data-[disabled='true']:text-ed-text-3",
				props.class,
			)}
		>
			{props.icon}
			{props.name}
			<Show when={props.badge}>
				{(badge) => (
					<span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-ed-ctl text-ed-text-2">
						{badge()}
					</span>
				)}
			</Show>
		</span>
	);
}

export function Field(
	props: ParentProps<{
		name: string;
		icon?: JSX.Element;
		value?: JSX.Element;
		badge?: string;
		class?: string;
		disabled?: boolean;
		inline?: boolean;
	}>,
) {
	return (
		<Show
			when={props.inline}
			fallback={
				<div class={cx("flex flex-col gap-2", props.class)}>
					<div class="flex flex-row gap-1.5 items-center">
						<FieldLabel
							name={props.name}
							badge={props.badge}
							disabled={props.disabled}
							icon={props.icon}
						/>
						<Show when={props.value}>
							<div class="ml-auto">{props.value}</div>
						</Show>
					</div>
					{props.children}
				</div>
			}
		>
			<div class={cx("flex flex-row gap-2 items-center h-[34px]", props.class)}>
				<FieldLabel
					name={props.name}
					badge={props.badge}
					disabled={props.disabled}
					class="min-w-24 shrink-0 whitespace-nowrap"
				/>
				<div class="flex flex-row flex-1 gap-2 justify-end items-center min-w-0 [&>.ed-slider]:flex-1">
					{props.children}
				</div>
				<Show when={props.value}>
					<div class="shrink-0 min-w-9 text-[11px] text-right tabular-nums text-ed-text-3">
						{props.value}
					</div>
				</Show>
			</div>
		</Show>
	);
}

export function Subfield(
	props: ParentProps<{ name: string; class?: string; required?: boolean }>,
) {
	return (
		<div
			class={cx(
				"flex flex-row gap-2 justify-between items-center h-[34px]",
				props.class,
			)}
		>
			<span class="text-[13px] font-normal text-ed-text-1">
				{props.name}
				{props.required && (
					<span class="ml-[2px] text-xs text-blue-500">*</span>
				)}
			</span>
			{props.children}
		</div>
	);
}

export function Slider(
	_props: ComponentProps<typeof KSlider> & {
		formatTooltip?: string | ((v: number) => string);
		history?: { pause: () => () => void };
		thumbClass?: string;
	},
) {
	const [local, props] = splitProps(_props, ["thumbClass"]);
	const context = useEditorContext();
	const history = props.history ?? context?.projectHistory;

	// Pause history when slider is being dragged
	let resumeHistory: (() => void) | null = null;

	const [thumbRef, setThumbRef] = createSignal<HTMLDivElement>();

	const thumbBounds = createElementBounds(thumbRef);

	const [dragging, setDragging] = createSignal(false);

	return (
		<KSlider
			{...props}
			class={cx(
				"ed-slider relative px-1 h-8 flex flex-row justify-stretch items-center",
				props.class,
			)}
			onChange={(v) => {
				if (!resumeHistory && history) resumeHistory = history.pause();
				props.onChange?.(v);
			}}
			onChangeEnd={(e) => {
				resumeHistory?.();
				resumeHistory = null;
				props.onChangeEnd?.(e);
			}}
		>
			<KSlider.Track
				class="h-[3px] transition-[height] relative mx-1 bg-ed-ctl-active rounded-full w-full before:content-[''] before:absolute before:inset-0 before:-top-3 before:-bottom-3"
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
				<KSlider.Fill class="absolute -ml-2 h-full rounded-full bg-ed-accent data-disabled:bg-ed-ctl-active" />
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
							"bg-ed-thumb rounded-full outline-hidden size-3.5 -top-[5.5px] shadow-[0_1px_3px_rgba(0,0,0,.25),0_0_0_.5px_rgba(0,0,0,.1)] data-disabled:opacity-50 after:content-[''] after:absolute after:inset-0 after:-m-3",
							local.thumbClass,
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
				"rounded-[7px] bg-ed-ctl border-0 py-[18px] h-8 font-normal placeholder:text-ed-text-3 text-xs caret-ed-accent transition-shadow duration-200 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent px-2 w-full outline-hidden text-ed-text-1",
				props.class,
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
		},
	) {
		return (
			<KDialog {...props}>
				<KDialog.Portal>
					{!props.hideOverlay && (
						<KDialog.Overlay class="fixed inset-0 z-50 bg-black/80 data-expanded:animate-in data-expanded:fade-in data-closed:animate-out data-closed:fade-out" />
					)}
					<div class="flex fixed inset-0 z-50 justify-center items-center">
						<KDialog.Content
							class={cx(
								props.contentClass,
								"z-50 text-sm rounded-[1.25rem] overflow-hidden border-0 bg-ed-card shadow-ed-pop min-w-88 data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 origin-top data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
								(props.size ?? "sm") === "sm" ? "max-w-96" : "max-w-3xl",
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
			<KDialog.CloseButton as={Button} variant="gray">
				Cancel
			</KDialog.CloseButton>
		);
	},
	ConfirmButton(_props: ComponentProps<typeof Button>) {
		const props = mergeProps(
			{ variant: "primary" } as ComponentProps<typeof Button>,
			_props,
		);
		return <Button {...props} />;
	},
	Footer(
		props: ComponentProps<"div"> & {
			close?: JSX.Element;
			leftFooterContent?: JSX.Element;
		},
	) {
		return (
			<div
				class={cx(
					"h-16 px-4 gap-3 flex flex-row items-center",
					props.leftFooterContent ? "justify-between" : "justify-center",
					props.class,
				)}
				{...props}
			>
				{props.leftFooterContent}
				<div class="flex flex-row gap-3 items-center">{props.children}</div>
			</div>
		);
	},
	Header(props: ComponentProps<"div">) {
		return <div {...props} class="h-14 px-4 flex flex-row items-center" />;
	},
	Content(props: ComponentProps<"div">) {
		return (
			<div
				{...props}
				class={cx("p-4 flex flex-col border-y border-ed-line", props.class)}
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
	}>,
) {
	return (
		<>
			<Dialog.Header>
				<KDialog.Title class="text-ed-text-1">{props.title}</KDialog.Title>
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
	_props: ComponentProps<T>,
) {
	const props = mergeProps({ as: "div" } as ComponentProps<T>, _props);

	return (
		<Polymorphic
			{...props}
			class={cx(
				props.class,
				"flex flex-row shrink-0 items-center gap-1.5 px-[0.675rem] py-1.5 rounded-lg outline-hidden text-nowrap overflow-hidden text-ellipsis w-full max-w-full",
				"text-[13px] text-ed-text-2 disabled:text-ed-text-3 data-highlighted:bg-ed-ctl-hover data-highlighted:text-ed-text-1",
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
	props: ComponentProps<T>,
) {
	return (
		<Polymorphic {...props} class={cx(dropdownContainerClasses, props.class)} />
	);
}

export function MenuItemList<T extends ValidComponent = "div">(
	_props: ComponentProps<T>,
) {
	const props = mergeProps({ as: "div" } as ComponentProps<T>, _props);

	return (
		<Polymorphic
			{...props}
			class={cx(
				props.class,
				"space-y-1.5 p-1.5 overflow-y-auto outline-hidden",
			)}
		/>
	);
}

const editorButtonStyles = cva(
	[
		"group flex flex-row items-center justify-center shrink-0 gap-1.5 rounded-[7px] font-medium",
		"focus:outline-solid focus:outline-2 focus:outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 transition-colors duration-100",
		"disabled:opacity-45",
		"[&_svg]:shrink-0",
	],
	{
		variants: {
			size: {
				sm: "h-[22px] min-w-[22px] text-[12px] [&_svg]:size-3.5",
				md: "h-7 min-w-7 text-[13px] [&_svg]:size-4",
			},
			variant: {
				primary:
					"text-ed-text-2 enabled:hover:not-data-pressed:bg-ed-ctl-hover enabled:hover:not-data-pressed:text-ed-text-1 enabled:active:not-data-pressed:bg-ed-ctl-active data-expanded:bg-ed-ctl-hover data-expanded:text-ed-text-1 outline-ed-accent focus:bg-transparent",
				text: "text-ed-text-1 enabled:hover:not-data-pressed:bg-ed-ctl-hover enabled:active:not-data-pressed:bg-ed-ctl-active data-expanded:bg-ed-ctl-hover outline-ed-accent focus:bg-transparent",
				danger:
					"text-ed-text-2 enabled:hover:not-data-pressed:bg-ed-ctl-hover enabled:hover:not-data-pressed:text-ed-text-1 data-expanded:bg-red-300 data-pressed:bg-red-300 data-expanded:text-white data-pressed:text-white outline-red-300",
			},
		},
		defaultVariants: { variant: "primary", size: "md" },
	},
);

const editorButtonLeftIconStyles =
	"flex items-center text-current transition-colors duration-100";

const editorButtonRightIconStyles =
	"flex items-center text-ed-text-3 [&_svg]:size-2.5!";

type EditorButtonProps<T extends ValidComponent = "button"> =
	PolymorphicProps<T> & {
		children?: JSX.Element | string;
		leftIcon?: JSX.Element;
		rightIcon?: JSX.Element;
		kbd?: string[];
		tooltipText?: string;
		comingSoon?: boolean;
		rightIconEnd?: boolean;
	} & VariantProps<typeof editorButtonStyles>;

export function EditorButton<T extends ValidComponent = "button">(
	props: EditorButtonProps<T>,
) {
	const [local, cvaProps, others] = splitProps(
		mergeProps(
			{ variant: "primary", size: "md" },
			props,
		) as unknown as EditorButtonProps,
		[
			"children",
			"leftIcon",
			"rightIcon",
			"tooltipText",
			"kbd",
			"ref",
			"comingSoon",
			"rightIconEnd",
		],
		["class", "variant", "size"],
	);

	// Resolve children once. Reading local.children directly inside the
	// reactive buttonClass() below would re-resolve a render-prop child (e.g.
	// a Kobalte <Select.Value>) on every class recompute, and that child's own
	// reactivity re-invalidates the class binding — an unbounded synchronous
	// re-entry that overflows the stack the instant such a trigger opens.
	const resolvedChildren = children(() => local.children as JSX.Element);
	const iconOnly = () => !resolvedChildren() && !local.rightIcon;

	const buttonContent = (
		<>
			{local.leftIcon && (
				<span class={editorButtonLeftIconStyles}>{local.leftIcon}</span>
			)}
			{resolvedChildren() && <span>{resolvedChildren()}</span>}
			{local.rightIcon && (
				<span
					class={cx(
						editorButtonRightIconStyles,
						local.rightIconEnd && "ml-auto",
					)}
				>
					{local.rightIcon}
				</span>
			)}
		</>
	);

	const buttonClass = () =>
		cx(
			editorButtonStyles({
				...cvaProps,
				class: cx(
					iconOnly()
						? cvaProps.size === "sm"
							? "w-[22px]"
							: "w-7"
						: cvaProps.size === "sm"
							? "px-1.5"
							: "px-[7px]",
					cvaProps.class,
				),
			}),
			local.rightIconEnd && "justify-between",
		);

	return (
		<>
			{local.tooltipText || local.comingSoon ? (
				<Tooltip
					kbd={local.kbd}
					content={local.comingSoon ? "Coming Soon" : local.tooltipText}
				>
					<Polymorphic
						as="button"
						{...others}
						class={buttonClass()}
						disabled={local.comingSoon}
					>
						{buttonContent}
					</Polymorphic>
				</Tooltip>
			) : (
				<Polymorphic as="button" {...others} class={buttonClass()}>
					{buttonContent}
				</Polymorphic>
			)}
		</>
	);
}

export const dropdownContainerClasses =
	"z-60 flex flex-col rounded-xl bg-ed-card shadow-ed-pop overflow-y-hidden outline-hidden";

export const topLeftAnimateClasses =
	"data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95 origin-top-left";

export const topCenterAnimateClasses =
	"data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95 origin-top-center";

export const topRightAnimateClasses =
	"data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95 origin-top-right";

export const topSlideAnimateClasses =
	"data-expanded:animate-in data-expanded:fade-in data-expanded:slide-in-from-top-1 data-closed:animate-out data-closed:fade-out data-closed:slide-out-to-top-1 origin-top-center";

export function ComingSoonTooltip(
	props: ComponentProps<typeof KTooltip> & { as?: ValidComponent },
) {
	const [trigger, root] = splitProps(props, ["children", "as"]);
	return (
		<KTooltip placement="top" openDelay={0} closeDelay={0} {...root}>
			<KTooltip.Trigger as={trigger.as ?? "div"}>
				{trigger.children}
			</KTooltip.Trigger>
			<KTooltip.Portal>
				<KTooltip.Content class="p-2 font-medium bg-gray-12 text-gray-1 data-expanded:animate-in data-expanded:slide-in-from-bottom-1 data-expanded:fade-in data-closed:animate-out data-closed:slide-out-to-bottom-1 data-closed:fade-out rounded-lg text-xs z-1000">
					Coming Soon
				</KTooltip.Content>
			</KTooltip.Portal>
		</KTooltip>
	);
}
