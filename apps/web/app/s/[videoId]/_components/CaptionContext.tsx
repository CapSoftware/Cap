"use client";

import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { getAvailableTranslations } from "@/actions/videos/get-available-translations";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
	translateTranscript,
} from "@/actions/videos/translate-transcript";

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
	const [selectedLanguage, setSelectedLanguage] =
		useState<CaptionLanguage>("original");
	const [isTranslating, setIsTranslating] = useState(false);
	const [translatedVttContent, setTranslatedVttContent] = useState<
		Map<LanguageCode, string>
	>(new Map());
	const [originalVttContent, setOriginalVttContent] = useState<string | null>(
		null,
	);

	const { data: availableData, isLoading: isLoadingAvailable } = useQuery({
		queryKey: ["availableTranslations", videoId],
		queryFn: () => getAvailableTranslations(videoId),
		enabled: transcriptionStatus === "COMPLETE",
		staleTime: 5 * 60 * 1000,
	});

	const availableTranslations = useMemo(
		() => availableData?.translations ?? [],
		[availableData],
	);

	const hasOriginal = availableData?.hasOriginal ?? false;

	const requestTranslation = useCallback(
		async (language: LanguageCode): Promise<string | null> => {
			return new Promise((resolve) => {
				setTranslatedVttContent((prev) => {
					const cached = prev.get(language);
					if (cached) {
						resolve(cached);
						return prev;
					}

					setIsTranslating(true);
					translateTranscript(videoId, language)
						.then((result) => {
							if (result.success && result.translatedVtt) {
								const vtt = result.translatedVtt;
								setTranslatedVttContent((p) => new Map(p).set(language, vtt));
								resolve(vtt);
							} else {
								resolve(null);
							}
						})
						.finally(() => {
							setIsTranslating(false);
						});

					return prev;
				});
			});
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
