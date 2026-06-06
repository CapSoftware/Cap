import { jaJP } from "./ja-JP";
import { zhTW } from "./zh-TW";

export type Locale = "en" | "zh-TW" | "ja-JP";

export interface LocaleMeta {
	value: Locale;
	label: string;
	nativeLabel: string;
}

export const LOCALE_META: LocaleMeta[] = [
	{ value: "en", label: "English", nativeLabel: "English" },
	{ value: "zh-TW", label: "Chinese (Traditional)", nativeLabel: "繁體中文" },
	{ value: "ja-JP", label: "Japanese", nativeLabel: "日本語" },
];

export const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
	"zh-TW": zhTW,
	"ja-JP": jaJP,
};
