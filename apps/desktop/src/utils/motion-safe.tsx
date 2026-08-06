import { type ParentProps, Show } from "solid-js";
import { Transition, type TransitionProps } from "solid-transition-group";
import { usePrefersReducedMotion } from "./use-media-query";

export function MotionSafeTransition(props: ParentProps<TransitionProps>) {
	const reducedMotion = usePrefersReducedMotion();

	return (
		<Show when={!reducedMotion()} fallback={props.children}>
			<Transition appear {...props}>
				{props.children}
			</Transition>
		</Show>
	);
}
