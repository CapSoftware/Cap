import { getAllWindows } from "@tauri-apps/api/window";
import { Show, Suspense } from "solid-js";
import { createCurrentRecordingQuery } from "~/utils/queries";

export default function () {
	const currentRecording = createCurrentRecordingQuery();

	getAllWindows().then((w) =>
		w.forEach((w) => {
			if (w.label === "camera" || w.label === "in-progress-recording")
				w.setFocus();
		}),
	);

	const bounds = () => {
		if (!currentRecording.data) return;
		if ("window" in currentRecording.data.target) {
			return currentRecording.data.target.window.bounds;
		}
		if ("area" in currentRecording.data.target) {
			return currentRecording.data.target.area.bounds;
		}
	};

	return (
		<Suspense>
			<Show when={bounds()}>
				{(bounds) => {
					getAllWindows().then((w) =>
						w.forEach((w) => {
							if (w.label === "camera" || w.label === "in-progress-recording")
								w.setFocus();
						}),
					);

					return (
						<div class="size-full">
							<div class="absolute inset-0 *:absolute *:bg-black/50 *:pointer-events-none">
								{(() => {
									const { size, position } = bounds();
									return (
										<>
											{/* Top blind */}
											<div
												class="top-0 left-0 w-full"
												style={{ height: `${position.y}px` }}
											/>
											{/* Bottom blind */}
											<div
												class="left-0 bottom-0 w-full"
												style={{ top: `${position.y + size.height}px` }}
											/>
											{/* Left blind */}
											<div
												class="left-0"
												style={{
													top: `${position.y}px`,
													width: `${position.x}px`,
													height: `${size.height}px`,
												}}
											/>
											{/* Right blind */}
											<div
												class="right-0"
												style={{
													top: `${position.y}px`,
													left: `${position.x + size.width}px`,
													height: `${size.height}px`,
												}}
											/>
										</>
									);
								})()}
							</div>
						</div>
					);
				}}
			</Show>
		</Suspense>
	);
}
