export const CloseX = (props: { class: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class={props.class}
			fill="none"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			viewBox="0 0 24 24"
		>
			<path d="M18 6L6 18M6 6l12 12"></path>
		</svg>
	);
};

export const Expand = (props: { class: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class={props.class}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8" />
			<path d="M3 16.2V21m0 0h4.8M3 21l6-6" />
			<path d="M21 7.8V3m0 0h-4.8M21 3l-6 6" />
			<path d="M3 7.8V3m0 0h4.8M3 3l6 6" />
		</svg>
	);
};

export const Minimize = (props: { class: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class={props.class}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<polyline points="4 14 10 14 10 20" />
			<polyline points="20 10 14 10 14 4" />
			<line x1="14" x2="21" y1="10" y2="3" />
			<line x1="3" x2="10" y1="21" y2="14" />
		</svg>
	);
};

export const Squircle = (props: { class: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={props.class}
		>
			<path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9-9-1.8-9-9 1.8-9 9-9" />
		</svg>
	);
};

export const Flip = (props: { class: string }) => {
	return (
		<svg
			class={props.class}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			viewBox="0 0 24 24"
		>
			<path d="M8 3H5a2 2 0 00-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 012 2v14a2 2 0 01-2 2h-3M12 20v2M12 14v2M12 8v2M12 2v2"></path>
		</svg>
	);
};
