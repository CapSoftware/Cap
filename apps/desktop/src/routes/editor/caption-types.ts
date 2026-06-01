import type { CaptionWord as BaseCaptionWord } from "~/utils/tauri";

export interface CaptionWordExtended extends BaseCaptionWord {
	deleted?: boolean;
	isFiller?: boolean;
	isPause?: boolean;
	bufferStart?: number;
	bufferEnd?: number;
	_markForRemoval?: boolean;
}
