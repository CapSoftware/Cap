import { Button } from "@cap/ui";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import clsx from "clsx";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import {
	libraryDoodleHost,
	NotesDoodle,
} from "../../_components/library-doodles";

export function NotesEmptyState({
	secondary = false,
}: {
	secondary?: boolean;
}) {
	return (
		<div
			className={clsx(
				libraryDoodleHost,
				"flex flex-col gap-3 items-center px-6 py-12 text-center rounded-2xl border border-dashed animate-in fade-in border-gray-5 bg-gray-1",
			)}
		>
			<NotesDoodle />
			<div className="flex flex-col gap-1 items-center">
				<p className="text-base font-medium text-gray-12">
					Record your meetings in the Cap desktop app
				</p>
				<p className="max-w-sm text-sm text-gray-10 text-pretty">
					Cap takes the notes. Share one and it shows up here.
				</p>
			</div>
			<Button
				href="/download"
				className="flex relative gap-2 justify-center items-center px-4 mt-1 h-9"
				size="sm"
				variant={secondary ? "secondary" : "dark"}
			>
				<FontAwesomeIcon className="size-3.5" icon={faDownload} />
				Download Cap
			</Button>
		</div>
	);
}
