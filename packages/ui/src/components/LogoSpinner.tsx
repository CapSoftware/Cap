export const LogoSpinner = ({ className }: { className: string }) => {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 40 40"
		>
			<rect
				width="39.5"
				height="39.5"
				x="0.25"
				y="0.25"
				fill="#fff"
				rx="7.75"
			></rect>
			<rect
				width="39.5"
				height="39.5"
				x="0.25"
				y="0.25"
				stroke="#E7EAF0"
				strokeWidth="0.5"
				rx="7.75"
			></rect>
			<path
				fill="#4785FF"
				d="M20 36c8.837 0 16-7.163 16-16 0-8.836-7.163-16-16-16-8.836 0-16 7.164-16 16 0 8.837 7.164 16 16 16z"
			></path>
			<path
				fill="#ADC9FF"
				d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13z"
			></path>
			<path
				fill="#fff"
				d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10z"
			></path>
		</svg>
	);
};
