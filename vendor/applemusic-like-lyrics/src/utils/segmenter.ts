export const graphemeSegmenter: Intl.Segmenter | null =
	typeof Intl !== "undefined" && Intl.Segmenter
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

export interface WordSegmenter {
	segment(text: string): Iterable<{
		segment: string;
		index: number;
		isWordLike?: boolean;
	}>;
}

const defaultWordSegmenter: WordSegmenter | null =
	typeof Intl !== "undefined" && Intl.Segmenter
		? new Intl.Segmenter(undefined, { granularity: "word" })
		: null;

export let wordSegmenter: WordSegmenter | null = defaultWordSegmenter;

/** Overrides word segmentation for subsequent layouts; null restores the native default. */
export function setWordSegmenter(segmenter: WordSegmenter | null): void {
	wordSegmenter = segmenter ?? defaultWordSegmenter;
}
