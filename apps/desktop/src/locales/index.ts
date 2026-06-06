import { zhTW } from "./zh-TW";

export type Locale = "en" | "zh-TW";

export interface LocaleMeta {
	value: Locale;
	label: string;
	nativeLabel: string;
}

export const LOCALE_META: LocaleMeta[] = [
	{ value: "en", label: "English", nativeLabel: "English" },
	{ value: "zh-TW", label: "Chinese (Traditional)", nativeLabel: "繁體中文" },
];

export const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
	"zh-TW": zhTW,
};
