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

export const DoubleArrowSwitcher = (props: { class: string }) => {
	return (
		<svg
			class={props.class}
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
		>
			<path
				d="M10.9521 9.11328C11.1032 8.96224 11.3479 8.96236 11.499 9.11328C11.6502 9.26445 11.6502 9.50996 11.499 9.66113L8.27344 12.8867C8.12234 13.0376 7.87768 13.0376 7.72656 12.8867L4.5 9.66113C4.34891 9.51003 4.34905 9.26447 4.5 9.11328C4.65117 8.96211 4.89668 8.96212 5.04785 9.11328L8 12.0654L10.9521 9.11328ZM7.72656 3.11328C7.87771 2.96232 8.12231 2.96229 8.27344 3.11328L11.499 6.33887C11.6502 6.49004 11.6502 6.73555 11.499 6.88672C11.3479 7.03752 11.1032 7.03764 10.9521 6.88672L8 3.93457L5.04785 6.88672C4.89667 7.03779 4.65114 7.03786 4.5 6.88672C4.34899 6.73557 4.34897 6.49001 4.5 6.33887L7.72656 3.11328Z"
				fill="currentColor"
			/>
		</svg>
	);
};

export const ArrowUpRight = (props: { class: string }) => {
	return (
		<svg
			class={props.class}
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
		>
			<path
				fill-rule="evenodd"
				clip-rule="evenodd"
				d="M11.9996 3.40039C12.0388 3.40037 12.0782 3.40352 12.1168 3.41113C12.14 3.41572 12.162 3.42446 12.1842 3.43164C12.1987 3.43635 12.2139 3.43946 12.2281 3.44531C12.2513 3.45485 12.2729 3.46725 12.2945 3.47949C12.3069 3.48651 12.3196 3.493 12.3316 3.50098C12.3649 3.52313 12.3962 3.548 12.4244 3.57617L12.5015 3.66992C12.5117 3.68534 12.5183 3.70266 12.5269 3.71875C12.5363 3.73619 12.5467 3.75307 12.5543 3.77148C12.5844 3.84455 12.6001 3.92218 12.6002 4V10.5C12.6002 10.8314 12.331 11.1006 11.9996 11.1006C11.6684 11.1004 11.4 10.8312 11.4 10.5V5.44922L4.42439 12.4248C4.19011 12.6591 3.81008 12.659 3.57576 12.4248C3.34145 12.1905 3.34145 11.8105 3.57576 11.5762L10.5513 4.60059H5.49959C5.1684 4.60038 4.89998 4.33124 4.89998 4C4.90019 3.66894 5.16853 3.4006 5.49959 3.40039H11.9996Z"
				fill="currentColor"
			/>
		</svg>
	);
};

export const RecordFill = (props: { class: string }) => {
	return (
		<svg
			class={props.class}
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
		>
			<path
				opacity="0.6"
				d="M14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14V15C4.13401 15 1 11.866 1 8C1 4.13401 4.13401 1 8 1C11.866 1 15 4.13401 15 8C15 11.866 11.866 15 8 15V14C11.3137 14 14 11.3137 14 8Z"
				fill="currentColor"
			/>
			<path d="M11 8C11 9.65685 9.65685 11 8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5C9.65685 5 11 6.34315 11 8Z" fill="currentColor" />
		</svg>
	);
};
