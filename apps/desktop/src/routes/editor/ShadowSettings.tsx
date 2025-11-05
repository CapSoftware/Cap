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
				class="flex gap-1 items-center w-full font-medium text-left transition duration-200 text-gray-12 hover:text-gray-10"
			>
				<span class="text-sm">Advanced shadow settings</span>
				<IconCapChevronDown
					class={cx(
						"size-5",
						isOpen() ? "transition-transform rotate-180" : "",
					)}
				/>
			</button>
			<KCollapsible open={isOpen()}>
				<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
					<div class="mt-4 space-y-6 font-medium">
						<Field name="Size">
							<Slider
								value={props.size.value}
								onChange={props.size.onChange}
								minValue={0}
								maxValue={100}
								step={0.1}
							/>
						</Field>
						<Field name="Opacity">
							<Slider
								value={props.opacity.value}
								onChange={props.opacity.onChange}
								minValue={0}
								maxValue={100}
								step={0.1}
							/>
						</Field>
						<Field name="Blur">
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
