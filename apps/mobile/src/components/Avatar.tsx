import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { fonts, squircle } from "@/theme";

type AvatarTone = {
	background: string;
	foreground: string;
};

const tones: AvatarTone[] = [
	{ background: "#e6f4fe", foreground: "#0d74ce" },
	{ background: "#e9f7ee", foreground: "#218358" },
	{ background: "#fdeef3", foreground: "#c2298a" },
	{ background: "#fff1e7", foreground: "#cc4e00" },
	{ background: "#f3effc", foreground: "#7c4dcc" },
	{ background: "#fff8e1", foreground: "#9e6c00" },
	{ background: "#eaf3ff", foreground: "#3358d4" },
	{ background: "#e7f6f4", foreground: "#0d8b7a" },
];

const hashString = (value: string) => {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(hash);
};

export const avatarInitials = (name: string | null) => {
	const trimmed = name?.trim();
	if (!trimmed) return "?";
	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return `${words[0][0] ?? ""}${words[words.length - 1][0] ?? ""}`.toUpperCase();
};

export const avatarTone = (name: string | null): AvatarTone =>
	tones[hashString(name?.trim() || "cap") % tones.length];

type AvatarProps = {
	name: string | null;
	size?: number;
	imageUrl?: string | null;
};

export function Avatar({ name, size = 36, imageUrl }: AvatarProps) {
	const tone = avatarTone(name);

	return (
		<View
			style={[
				styles.base,
				{
					width: size,
					height: size,
					borderRadius: size / 2,
					backgroundColor: tone.background,
				},
			]}
		>
			{imageUrl ? (
				<Image
					cachePolicy="memory-disk"
					contentFit="cover"
					source={{ uri: imageUrl }}
					style={{ width: size, height: size }}
				/>
			) : (
				<Text
					allowFontScaling={false}
					style={[
						styles.initials,
						{ color: tone.foreground, fontSize: Math.round(size * 0.38) },
					]}
				>
					{avatarInitials(name)}
				</Text>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	base: {
		alignItems: "center",
		justifyContent: "center",
		overflow: "hidden",
		...squircle,
	},
	initials: {
		fontFamily: fonts.medium,
	},
});
