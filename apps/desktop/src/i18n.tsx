import {
	createContext,
	createSignal,
	onCleanup,
	onMount,
	type ParentProps,
	useContext,
} from "solid-js";
import { dictionaries, type Locale } from "./locales";
import { uiSettingsStore } from "./store";

export { LOCALE_META } from "./locales";
export type { Locale };
export type TranslateParams = Record<string, string | number>;

interface I18nContextValue {
	locale: () => Locale;
	setLocale: (locale: Locale) => void;
	t: (key: string, params?: TranslateParams) => string;
}

const I18nContext = createContext<I18nContextValue>();

function interpolate(template: string, params?: TranslateParams): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) =>
		name in params ? String(params[name]) : match,
	);
}

export function I18nProvider(props: ParentProps) {
	const [locale, setLocaleSignal] = createSignal<Locale>("en");

	let unlisten: (() => void) | undefined;
	onMount(async () => {
		const settings = await uiSettingsStore.get();
		if (settings?.language) setLocaleSignal(settings.language);
		unlisten = await uiSettingsStore.listen((data) => {
			if (data?.language) setLocaleSignal(data.language);
		});
	});
	onCleanup(() => unlisten?.());

	const setLocale = (next: Locale) => {
		setLocaleSignal(next);
		uiSettingsStore.set({ language: next });
	};

	const t = (key: string, params?: TranslateParams) => {
		const template = dictionaries[locale()]?.[key] ?? key;
		return interpolate(template, params);
	};

	return (
		<I18nContext.Provider value={{ locale, setLocale, t }}>
			{props.children}
		</I18nContext.Provider>
	);
}

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
	return ctx;
}
