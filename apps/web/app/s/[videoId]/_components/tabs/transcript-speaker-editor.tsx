import { useState } from "react";
import { MAX_SPEAKER_NAME_LENGTH } from "@/lib/transcript-speakers";

export function TranscriptSpeakerEditor({
	speaker,
	name,
	onSave,
}: {
	speaker: string;
	name: string;
	onSave: (speaker: string, name: string) => Promise<string | null>;
}) {
	const [value, setValue] = useState(name);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = async (name: string) => {
		setSaving(true);
		try {
			const failure = await onSave(speaker, name);
			setError(failure);
			if (!failure) setValue(name);
		} finally {
			setSaving(false);
		}
	};
	return (
		<form
			className="flex flex-wrap items-center gap-2 py-1"
			onSubmit={(event) => {
				event.preventDefault();
				void save(value);
			}}
		>
			<label className="text-xs" htmlFor={`speaker-${speaker}`}>
				Speaker {speaker}
			</label>
			<input
				id={`speaker-${speaker}`}
				className="min-w-0 rounded border border-gray-4 px-2 text-xs"
				value={value}
				maxLength={MAX_SPEAKER_NAME_LENGTH}
				disabled={saving}
				placeholder={`Speaker ${speaker}`}
				onChange={(event) => setValue(event.target.value)}
			/>
			<button type="submit" className="text-xs" disabled={saving}>
				Save name
			</button>
			<button
				type="button"
				className="text-xs"
				disabled={saving}
				onClick={() => void save("")}
			>
				Reset
			</button>
			{error && (
				<span role="alert" className="text-xs text-red-500">
					{error}
				</span>
			)}
		</form>
	);
}
