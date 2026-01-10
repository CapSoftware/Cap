import {
	createContext,
	createMemo,
	createSignal,
	useContext,
	type ParentProps,
	type Accessor,
} from "solid-js";
import { createStore } from "solid-js/store";
import * as i18n from "@solid-primitives/i18n";
import enUS from "./en-US";
import zhCN from "./zh-CN";
import type { Dictionary } from "./types";

type Locale = "en-US" | "zh-CN";

type I18nContextType = {
	locale: Accessor<Locale>;
	setLocale: (locale: Locale) => void;
	t: i18n.Translator<Dictionary>;
};

const I18nContext = createContext<I18nContextType>();

export function I18nProvider(props: ParentProps) {
	// Simple detection of system locale
	const systemLocale = navigator.language;
	const defaultLocale: Locale = systemLocale.startsWith("zh")
		? "zh-CN"
		: "en-US";

	const storedLocale = localStorage.getItem("cap-locale") as Locale | null;
	const systemLocale = navigator.language;
	const defaultLocale: Locale = storedLocale ?? (systemLocale.startsWith("zh")
		? "zh-CN"
		: "en-US");

	const [locale, setLocale] = createSignal<Locale>(defaultLocale);

	createEffect(() => {
		localStorage.setItem("cap-locale", locale());
	});

	const [dictionaries] = createStore({
		"en-US": enUS,
		"zh-CN": zhCN,
	});

	const flatDictionaries = createMemo(() =>
		i18n.flatten(dictionaries[locale()]),
	);

	const translator = i18n.translator(flatDictionaries, i18n.resolveTemplate);

	const value = {
		locale,
		setLocale,
		t: translator,
	};

	return (
		<I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
	);
}

export function useI18n() {
	const context = useContext(I18nContext);
	if (!context) {
		throw new Error("useI18n must be used within an I18nProvider");
	}
	return context;
}
