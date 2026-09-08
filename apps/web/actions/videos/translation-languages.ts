// Deep import on purpose: this file is pulled into CLIENT code (the share
// page's caption context), and the @cap/web-domain barrel would drag the
// whole effect runtime (~250 KB gz) into that bundle. Language.ts itself is
// dependency-free.
export {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "@cap/web-domain/src/Language";
