import { onCleanup, onMount } from "solid-js";
import toast, { Toaster } from "solid-toast";
import { createTauriEventListener } from "~/utils/createEventListener";
import { events } from "~/utils/tauri";

export default function Page() {
	let unlisten: (() => void) | undefined;

	const SuccessIcon = () => (
		<svg
			class="w-6 h-6"
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 142 142"
		>
			<path
				fill="#fff"
				d="M113.6.888H28.4C13.205.888.887 13.205.887 28.4v85.2c0 15.195 12.318 27.513 27.513 27.513h85.2c15.195 0 27.512-12.318 27.512-27.513V28.4c0-15.195-12.317-27.512-27.512-27.512"
			></path>
			<path
				fill="#4785FF"
				d="M71 127.8c31.37 0 56.8-25.43 56.8-56.8S102.37 14.2 71 14.2 14.2 39.63 14.2 71s25.43 56.8 56.8 56.8"
			></path>
			<path
				fill="#ADC9FF"
				d="M71 117.15c25.488 0 46.15-20.662 46.15-46.15S96.488 24.85 71 24.85 24.85 45.512 24.85 71 45.512 117.15 71 117.15"
			></path>
			<path
				fill="#fff"
				d="M71 106.5c19.606 0 35.5-15.894 35.5-35.5S90.606 35.5 71 35.5 35.5 51.394 35.5 71s15.894 35.5 35.5 35.5"
			></path>
		</svg>
	);

	createTauriEventListener(events.newNotification, (payload) => {
		if (payload.is_error) {
			toast.error(payload.body, {
				style: {
					background: "#FEE2E2",
					color: "#991B1B",
					border: "1px solid #F87171",
				},
				iconTheme: {
					primary: "#991B1B",
					secondary: "#FEE2E2",
				},
			});
		} else {
			toast.success(payload.body, {
				icon: <SuccessIcon />,
				style: {
					background: "#FFFFFF",
					color: "#000000",
					border: "1px solid #FFFFFF",
				},
			});
		}
	});

	return (
		<>
			<style>
				{`
          body {
            background: transparent !important;
          }
        `}
			</style>
			<Toaster
				position="top-right"
				toastOptions={{
					duration: 3500,
					style: {
						padding: "8px 16px",
						"border-radius": "15px",
						"font-size": "1rem",
					},
				}}
			/>
		</>
	);
}
