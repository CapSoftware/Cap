import { Edit3, LoaderCircle } from "lucide-react";
import { memo, useState } from "react";
import type { TranscriptEntry } from "../utils/parse-transcript-vtt";

export const TranscriptRow = memo(function TranscriptRow({
	entry,
	selected,
	canEdit,
	onSelect,
	onEdit,
}: {
	entry: TranscriptEntry;
	selected: boolean;
	canEdit: boolean;
	onSelect: (entry: TranscriptEntry) => void;
	onEdit: (entry: TranscriptEntry) => void;
}) {
	return (
		<div
			className={`group flex items-start gap-1 rounded-lg px-2 transition-colors ${
				selected ? "bg-gray-3" : "hover:bg-gray-2"
			}`}
		>
			<button
				className="flex min-w-0 flex-1 items-baseline gap-2.5 py-1.5 text-left"
				onClick={() => onSelect(entry)}
				type="button"
			>
				<span className="min-w-9 shrink-0 font-mono text-[10px] leading-[22px] tabular-nums text-gray-8">
					{entry.timestamp}
				</span>
				<span className="min-w-0 flex-1 text-[13px] leading-[22px] text-gray-11">
					{entry.text}
				</span>
			</button>
			{canEdit && (
				<button
					onClick={(event) => {
						event.stopPropagation();
						onEdit(entry);
					}}
					type="button"
					aria-label="Edit transcript entry"
					title="Edit transcript entry"
					className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-gray-9 opacity-0 transition-all hover:bg-gray-4 hover:text-gray-12 focus-visible:opacity-100 group-hover:opacity-100"
				>
					<Edit3 className="size-3" />
				</button>
			)}
		</div>
	);
});

export function TranscriptEditor({
	entry,
	isSaving,
	onSave,
	onCancel,
}: {
	entry: TranscriptEntry;
	isSaving: boolean;
	onSave: (text: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [editText, setEditText] = useState(entry.text);

	return (
		<div className="min-w-0 flex-1 py-2">
			<textarea
				value={editText}
				onChange={(e) => setEditText(e.target.value)}
				className="w-full resize-none rounded-lg border border-gray-4 bg-gray-1 p-2.5 text-[13px] leading-[22px] text-gray-12 outline-none transition placeholder:text-gray-8 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
				rows={Math.max(2, Math.ceil(editText.length / 60))}
				onClick={(e) => e.stopPropagation()}
				placeholder="Edit transcript text..."
			/>
			<div className="mt-2 flex justify-end gap-1.5">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onCancel();
					}}
					disabled={isSaving}
					className="inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium text-gray-11 transition hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						void onSave(editText);
					}}
					disabled={isSaving || !editText.trim()}
					className="inline-flex h-7 items-center gap-1.5 rounded-full bg-gray-12 px-3 text-[11px] font-semibold text-white transition hover:bg-gray-11 disabled:pointer-events-none disabled:opacity-50"
				>
					{isSaving && <LoaderCircle className="size-3 animate-spin" />}
					Save
				</button>
			</div>
		</div>
	);
}
