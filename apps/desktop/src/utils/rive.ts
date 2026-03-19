import { createRive as riveSolidCanvas_createRive } from "@aerofoil/rive-solid-canvas";
import type { Rive as InternalRive, RiveParameters } from "@rive-app/canvas";
import { type Accessor, createEffect, type JSX } from "solid-js";

export function createRive(
	riveParameters: Accessor<Omit<RiveParameters, "canvas">>,
): {
	canvas: () => Accessor<HTMLCanvasElement | undefined>;
	rive: Accessor<InternalRive | undefined>;
	RiveComponent: (
		props: JSX.CanvasHTMLAttributes<HTMLCanvasElement>,
	) => JSX.Element;
} {
	const { canvas, rive, RiveComponent } =
		riveSolidCanvas_createRive(riveParameters);

	createEffect(() => rive()?.resizeDrawingSurfaceToCanvas());

	return { canvas, rive, RiveComponent };
}
