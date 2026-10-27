"use client";

import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getAvailableTranslations } from "@/actions/videos/get-available-translations";
import { translateTranscript } from "@/actions/videos/translate-transcript";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "@/actions/videos/translation-languages";

export type CaptionLanguage = LanguageCode | "original" | "off";

interface AvailableTranslation {
	code: LanguageCode;
	name: string;
}

interface CaptionContextValue {
	selectedLanguage: CaptionLanguage;
	setSelectedLanguage: (language: CaptionLanguage) => void;
	isTranslating: boolean;
	availableTranslations: AvailableTranslation[];
	hasOriginal: boolean;
	isLoadingAvailable: boolean;
	translatedVttContent: Map<LanguageCode, string>;
	currentVttContent: string | null;
	setOriginalVttContent: (content: string | null) => void;
	requestTranslation: (language: LanguageCode) => Promise<string | null>;
}

const CaptionContext = createContext<CaptionContextValue | null>(null);

interface CaptionProviderProps {
	children: ReactNode;
	videoId: Video.VideoId;
	transcriptionStatus?: string | null;
}

export function CaptionProvider({
	children,
	videoId,
	transcriptionStatus,
}: CaptionProviderProps) {
	return (
		<CaptionProviderForVideo
			key={videoId}
			videoId={videoId}
			transcriptionStatus={transcriptionStatus}
		>
			{children}
		</CaptionProviderForVideo>
	);
}

function CaptionProviderForVideo({
	children,
	videoId,
	transcriptionStatus,
}: CaptionProviderProps) {
	const [selectedLanguage, setSelectedLanguage] =
		useState<CaptionLanguage>("original");
	const [isTranslating, setIsTranslating] = useState(false);
	const [translatedVttContent, setTranslatedVttContent] = useState<
		Map<LanguageCode, string>
	>(new Map());
	const [originalVttContent, setOriginalVttContent] = useState<string | null>(
		null,
	);
	const mounted = useRef(true);
	const translations = useRef(new Map<LanguageCode, string>());
	const pending = useRef(new Map<LanguageCode, Promise<string | null>>());

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const { data: availableData, isLoading: isLoadingAvailable } = useQuery({
		queryKey: ["availableTranslations", videoId],
		queryFn: () => getAvailableTranslations(videoId),
		enabled: transcriptionStatus === "COMPLETE",
		staleTime: 5 * 60 * 1000,
	});

	const availableTranslations = useMemo(() => {
		const savedTranslations = availableData?.translations ?? [];
		const savedCodes = new Set(savedTranslations.map(({ code }) => code));
		return [
			...savedTranslations,
			...Array.from(translatedVttContent.keys())
				.filter((code) => !savedCodes.has(code))
				.map((code) => ({ code, name: SUPPORTED_LANGUAGES[code] })),
		];
	}, [availableData, translatedVttContent]);

	const hasOriginal = availableData?.hasOriginal ?? false;

	const requestTranslation = useCallback(
		(language: LanguageCode): Promise<string | null> => {
			const cached = translations.current.get(language);
			if (cached) return Promise.resolve(cached);
			const existing = pending.current.get(language);
			if (existing) return existing;

			const request = Promise.resolve()
				.then(() => translateTranscript(videoId, language))
				.then((result) => {
					if (!result.success || !result.translatedVtt) return null;
					if (mounted.current) {
						translations.current.set(language, result.translatedVtt);
						setTranslatedVttContent(new Map(translations.current));
					}
					return result.translatedVtt;
				})
				.catch(() => null)
				.finally(() => {
					if (pending.current.get(language) === request)
						pending.current.delete(language);
					if (mounted.current) setIsTranslating(pending.current.size > 0);
				});
			pending.current.set(language, request);
			if (mounted.current) setIsTranslating(true);
			return request;
		},
		[videoId],
	);

	const currentVttContent = useMemo(() => {
		if (selectedLanguage === "off") {
			return null;
		}
		if (selectedLanguage === "original") {
			return originalVttContent;
		}
		return translatedVttContent.get(selectedLanguage) ?? null;
	}, [selectedLanguage, originalVttContent, translatedVttContent]);

	const handleSetSelectedLanguage = useCallback(
		async (language: CaptionLanguage) => {
			setSelectedLanguage(language);

			if (
				language !== "off" &&
				language !== "original" &&
				!translatedVttContent.has(language)
			) {
				await requestTranslation(language);
			}
		},
		[translatedVttContent, requestTranslation],
	);

	const value: CaptionContextValue = useMemo(
		() => ({
			selectedLanguage,
			setSelectedLanguage: handleSetSelectedLanguage,
			isTranslating,
			availableTranslations,
			hasOriginal,
			isLoadingAvailable,
			translatedVttContent,
			currentVttContent,
			setOriginalVttContent,
			requestTranslation,
		}),
		[
			selectedLanguage,
			handleSetSelectedLanguage,
			isTranslating,
			availableTranslations,
			hasOriginal,
			isLoadingAvailable,
			translatedVttContent,
			currentVttContent,
			requestTranslation,
		],
	);

	return (
		<CaptionContext.Provider value={value}>{children}</CaptionContext.Provider>
	);
}

export function useCaptionContext(): CaptionContextValue {
	const context = useContext(CaptionContext);
	if (!context) {
		throw new Error("useCaptionContext must be used within a CaptionProvider");
	}
	return context;
}

export function useCaptionContextOptional(): CaptionContextValue | null {
	return useContext(CaptionContext);
}

export { SUPPORTED_LANGUAGES };
export type { LanguageCode };
