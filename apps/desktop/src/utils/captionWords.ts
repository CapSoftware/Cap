import type { CaptionSegment, CaptionWord } from "~/utils/tauri";

const MIN_DURATION = 0.001;

function safeDuration(start: number, end: number): number {
  const duration = end - start;
  return duration > MIN_DURATION ? duration : MIN_DURATION;
}

function normalizeWordTimings(
  words: CaptionWord[],
  segmentStart: number,
  segmentEnd: number,
): CaptionWord[] {
  if (words.length === 0) {
    return [];
  }

  if (segmentEnd < segmentStart) {
    const normalized = normalizeWordTimings(
      words
        .slice()
        .reverse()
        .map((word) => ({
          text: word.text,
          start: segmentEnd + segmentStart - word.end,
          end: segmentEnd + segmentStart - word.start,
        })),
      segmentEnd,
      segmentStart,
    );

    return normalized.reverse();
  }

  const normalized: CaptionWord[] = [];
  let previousEnd = segmentStart;

  words.forEach((word, index) => {
    const baseStart = Number.isFinite(word.start) ? word.start : segmentStart;
    let start = Math.max(baseStart, segmentStart, previousEnd);
    let end = Number.isFinite(word.end) ? word.end : start;
    end = Math.max(end, start);

    if (index === words.length - 1) {
      end = segmentEnd;
    } else if (end > segmentEnd) {
      end = segmentEnd;
    }

    normalized.push({
      text: word.text,
      start,
      end,
    });

    previousEnd = end;
  });

  normalized[0].start = segmentStart;
  normalized[normalized.length - 1].end = segmentEnd;

  return normalized;
}

function characterWeight(word: string): number {
  const weight = word.replace(/[^A-Za-z0-9]/g, "").length;
  return weight > 0 ? weight : 1;
}

function distributeWordsByCharacters(
  tokens: string[],
  segmentStart: number,
  segmentEnd: number,
): CaptionWord[] {
  const cleaned = tokens.filter((token) => token.length > 0);
  if (cleaned.length === 0) {
    return [];
  }

  if (segmentEnd < segmentStart) {
    const distributed = distributeWordsByCharacters(
      cleaned.slice().reverse(),
      segmentEnd,
      segmentStart,
    );

    return distributed.reverse().map((word) => ({
      text: word.text,
      start: segmentStart + segmentEnd - word.end,
      end: segmentStart + segmentEnd - word.start,
    }));
  }

  const duration = segmentEnd - segmentStart;
  if (duration <= 0) {
    return cleaned.map((text) => ({
      text,
      start: segmentStart,
      end: segmentStart,
    }));
  }

  const totalWeight = cleaned.reduce((sum, token) => sum + characterWeight(token), 0);

  let cursor = segmentStart;
  const provisional: CaptionWord[] = cleaned.map((text, index) => {
    const weight = totalWeight > 0 ? characterWeight(text) : 1;
    const ratio = totalWeight > 0 ? weight / totalWeight : 1 / cleaned.length;

    let end = index === cleaned.length - 1
      ? segmentEnd
      : cursor + duration * ratio;

    if (end > segmentEnd) {
      end = segmentEnd;
    }

    const word: CaptionWord = {
      text,
      start: cursor,
      end,
    };

    cursor = end;
    return word;
  });

  return normalizeWordTimings(provisional, segmentStart, segmentEnd);
}

function reuseWordRatios(
  tokens: string[],
  existingWords: CaptionWord[],
  previousStart: number,
  previousEnd: number,
  nextStart: number,
  nextEnd: number,
): CaptionWord[] {
  if (tokens.length === 0) {
    return [];
  }

  if (nextEnd < nextStart) {
    const reused = reuseWordRatios(
      tokens.slice().reverse(),
      existingWords.slice().reverse(),
      Math.min(previousStart, previousEnd),
      Math.max(previousStart, previousEnd),
      nextEnd,
      nextStart,
    );

    return reused.reverse();
  }

  const previousDuration = safeDuration(previousStart, previousEnd);
  const nextDuration = safeDuration(nextStart, nextEnd);

  return tokens.map((text, index) => {
    const previousWord = existingWords[index];
    const startRatio = (previousWord.start - previousStart) / previousDuration;
    const endRatio = (previousWord.end - previousStart) / previousDuration;

    const start = nextStart + startRatio * nextDuration;
    const end = nextStart + endRatio * nextDuration;

    return { text, start, end };
  });
}

function scaleWordTimings(
  words: CaptionWord[],
  previousStart: number,
  previousEnd: number,
  nextStart: number,
  nextEnd: number,
): CaptionWord[] {
  if (words.length === 0) {
    return [];
  }

  if (nextEnd < nextStart) {
    const scaled = scaleWordTimings(
      words.slice().reverse().map((word) => ({
        text: word.text,
        start: previousEnd + previousStart - word.end,
        end: previousEnd + previousStart - word.start,
      })),
      Math.min(previousStart, previousEnd),
      Math.max(previousStart, previousEnd),
      nextEnd,
      nextStart,
    );

    return scaled.reverse();
  }

  if (previousEnd < previousStart) {
    [previousStart, previousEnd] = [previousEnd, previousStart];
  }

  const previousDuration = safeDuration(previousStart, previousEnd);
  const nextDuration = safeDuration(nextStart, nextEnd);

  const provisional = words.map((word) => {
    const startRatio = (word.start - previousStart) / previousDuration;
    const endRatio = (word.end - previousStart) / previousDuration;

    const start = nextStart + startRatio * nextDuration;
    const end = nextStart + endRatio * nextDuration;

    return {
      text: word.text,
      start,
      end,
    };
  });

  return normalizeWordTimings(provisional, nextStart, nextEnd);
}

function rebuildWordsForText(
  text: string,
  segmentStart: number,
  segmentEnd: number,
  existingWords: CaptionWord[],
  previousStart: number,
  previousEnd: number,
): CaptionWord[] {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return [];
  }

  if (segmentEnd < segmentStart) {
    const rebuilt = rebuildWordsForText(
      text,
      segmentEnd,
      segmentStart,
      existingWords,
      previousStart,
      previousEnd,
    );

    return rebuilt.reverse().map((word) => ({
      text: word.text,
      start: segmentStart + segmentEnd - word.end,
      end: segmentStart + segmentEnd - word.start,
    }));
  }

  const previousDuration = Math.abs(previousEnd - previousStart);
  if (
    existingWords.length === tokens.length &&
    previousDuration > MIN_DURATION
  ) {
    const reused = reuseWordRatios(
      tokens,
      existingWords,
      previousStart,
      previousEnd,
      segmentStart,
      segmentEnd,
    );

    return normalizeWordTimings(reused, segmentStart, segmentEnd);
  }

  return distributeWordsByCharacters(tokens, segmentStart, segmentEnd);
}

export function buildWordsFromText(
  text: string,
  start: number,
  end: number,
): CaptionWord[] {
  return rebuildWordsForText(text, start, end, [], start, end);
}

export function applySegmentUpdates(
  segment: CaptionSegment,
  updates: Partial<Pick<CaptionSegment, "start" | "end" | "text">>,
): CaptionSegment {
  const nextStart = updates.start ?? segment.start;
  const nextEnd = updates.end ?? segment.end;
  const nextText = updates.text ?? segment.text;

  const existingWords = segment.words ?? [];
  const timingChanged =
    updates.start !== undefined || updates.end !== undefined;
  const textChanged =
    updates.text !== undefined && updates.text !== segment.text;

  let words: CaptionWord[];

  if (textChanged) {
    words = rebuildWordsForText(
      nextText,
      nextStart,
      nextEnd,
      existingWords,
      segment.start,
      segment.end,
    );
  } else if (existingWords.length > 0 && timingChanged) {
    words = scaleWordTimings(
      existingWords,
      segment.start,
      segment.end,
      nextStart,
      nextEnd,
    );
  } else if (existingWords.length > 0) {
    words = existingWords.map((word) => ({ ...word }));
  } else {
    words = buildWordsFromText(nextText, nextStart, nextEnd);
  }

  return {
    ...segment,
    ...updates,
    words,
  };
}
