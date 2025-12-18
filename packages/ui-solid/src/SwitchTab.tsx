import { Tabs as KTabs } from "@kobalte/core/tabs";
import { cx } from "cva";
import { type ComponentProps, splitProps, type ValidComponent } from "solid-js";

function Root(props: ComponentProps<typeof KTabs>) {
	return <KTabs {...props} />;
}

function List(props: ComponentProps<typeof KTabs.List>) {
	const [local, others] = splitProps(props, ["class", "children"]);
	return (
		<KTabs.List
			{...others}
			class={cx(
				"flex flex-row items-center rounded-lg relative border",
				local.class,
			)}
		>
			{local.children}
			<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden">
				<div class="bg-gray-1 flex-1" />
			</KTabs.Indicator>
		</KTabs.List>
	);
}

function Trigger<T extends ValidComponent = "button">(
	props: ComponentProps<typeof KTabs.Trigger<T>>,
) {
	const [local, others] = splitProps(
		props as ComponentProps<typeof KTabs.Trigger<"button">>,
		["class"],
	);
	return (
		<KTabs.Trigger
			{...others}
			class={cx(
				"flex-1 text-gray-8 py-1 z-10 data-selected:text-gray-1 peer outline-none transition-colors duration-100",
				local.class,
			)}
		/>
	);
}

export const SwitchTab = Object.assign(Root, {
	List,
	Trigger,
});
