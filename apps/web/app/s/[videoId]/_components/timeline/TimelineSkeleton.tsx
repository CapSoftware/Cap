/**
 * Lives in its own module so `Share.tsx` can render it as the Suspense
 * fallback without statically importing `TimelineView`, which would pull the
 * timeline back into the main chunk and defeat the `next/dynamic` split.
 *
 * Heights and chrome track the band in `TimelineView`: filmstrip ghost, then
 * the control-bar row closing the card. The comments shelf only exists when
 * there are branches, so the skeleton shows the collapsed shape.
 */
export function TimelineSkeleton() {
	return (
		<div className="flex w-full flex-col">
			<div className="h-11 shrink-0 animate-pulse bg-gray-3 lg:h-16" />
			<div className="flex h-14 shrink-0 items-center rounded-b-xl border-t border-gray-4 bg-white pl-4">
				<div className="size-8 rounded-full bg-gray-4" />
			</div>
		</div>
	);
}
