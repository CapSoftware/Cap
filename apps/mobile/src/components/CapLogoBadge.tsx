import Svg, { Path, Rect } from "react-native-svg";
import { colors } from "@/theme";

type CapLogoBadgeProps = {
	size?: number;
};

export function CapLogoBadge({ size = 48 }: CapLogoBadgeProps) {
	return (
		<Svg
			accessibilityLabel="Cap logo"
			accessibilityRole="image"
			width={size}
			height={size}
			viewBox="0 0 40 40"
		>
			<Rect width={40} height={40} fill={colors.white} rx={8} />
			<Path
				fill="#4785FF"
				d="M20 36c8.837 0 16-7.163 16-16 0-8.836-7.163-16-16-16-8.836 0-16 7.164-16 16 0 8.837 7.164 16 16 16z"
			/>
			<Path
				fill="#ADC9FF"
				d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13z"
			/>
			<Path
				fill={colors.white}
				d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10z"
			/>
		</Svg>
	);
}
