import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { cx } from "cva";
import { createSignal } from "solid-js";
import { Field, Slider } from "./ui";

interface Props {
	size: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	opacity: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	blur: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	scrollRef?: HTMLDivElement;
}

const ShadowSettings = (props: Props) => {
	const [isOpen, setIsOpen] = createSignal(false);

	const handleToggle = () => {
		setIsOpen(!isOpen());
		setTimeout(() => {
			if (props.scrollRef) {
				props.scrollRef.scrollTo({
					top: props.scrollRef.scrollHeight,
					behavior: "smooth",
				});
			}
		}, 200);
	};

	return (
		<div class="w-full h-full">
			<button
				type="button"
				onClick={handleToggle}
				class="flex gap-1 items-center w-full text-left transition-colors duration-200 outline-hidden text-ed-text-2 hover:text-ed-text-1"
			>
				<span class="text-[12px] font-medium">Advanced shadow settings</span>
				<IconCapChevronDown
					class={cx(
						"size-3.5 text-ed-text-3 transition-transform duration-200",
						isOpen() && "rotate-180",
					)}
				/>
			</button>
			<KCollapsible open={isOpen()}>
				<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
					<div class="flex flex-col mt-2">
						<Field inline name="Size" value={props.size.value[0]?.toFixed(1)}>
							<Slider
								value={props.size.value}
								onChange={props.size.onChange}
								minValue={0}
								maxValue={100}
								step={0.1}
							/>
						</Field>
						<Field
							inline
							name="Opacity"
							value={props.opacity.value[0]?.toFixed(1)}
						>
							<Slider
								value={props.opacity.value}
								onChange={props.opacity.onChange}
								minValue={0}
								maxValue={100}
								step={0.1}
							/>
						</Field>
						<Field inline name="Blur" value={props.blur.value[0]?.toFixed(1)}>
							<Slider
								value={props.blur.value}
								onChange={props.blur.onChange}
								minValue={0}
								maxValue={100}
								step={0.1}
							/>
						</Field>
					</div>
				</KCollapsible.Content>
			</KCollapsible>
		</div>
	);
};

export default ShadowSettings;
