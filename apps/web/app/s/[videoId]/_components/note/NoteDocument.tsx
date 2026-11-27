import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { NoteMeetingTime } from "./NoteMeetingTime";

const SHOWN_PARTICIPANTS = 3;

const PROSE_CLASS =
	"text-sm leading-6 text-gray-12 prose prose-sm prose-gray max-w-none prose-p:my-2 prose-p:leading-6 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:leading-6 prose-strong:text-gray-12 prose-headings:font-medium prose-headings:tracking-normal prose-headings:text-gray-12 prose-h1:mt-8 prose-h1:mb-2 prose-h1:text-lg prose-h2:mt-8 prose-h2:mb-2 prose-h2:text-lg prose-h3:mt-6 prose-h3:mb-1.5 prose-h3:text-base prose-h4:mt-5 prose-h4:mb-1 prose-h4:text-sm prose-a:font-normal prose-a:text-blue-11 prose-code:text-gray-12 prose-blockquote:border-gray-5 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-gray-11 prose-hr:my-6 prose-hr:border-gray-4 first:[&>*]:mt-0 last:[&>*]:mb-0 [&_ul.contains-task-list]:pl-0 [&_li.task-list-item]:flex [&_li.task-list-item]:gap-2.5 [&_li.task-list-item]:items-start [&_li.task-list-item]:pl-0 [&_li.task-list-item]:list-none";

const formatMeetingLength = (seconds: number) => {
	const minutes = Math.max(1, Math.round(seconds / 60));
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${minutes} min`;
	return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
};

function TaskMark({ checked }: { checked: boolean }) {
	return (
		<span
			role="img"
			aria-label={checked ? "Done" : "To do"}
			className={
				checked
					? "flex justify-center items-center mt-1 text-white rounded-[5px] border size-4 shrink-0 bg-blue-9 border-blue-9"
					: "mt-1 rounded-[5px] border size-4 shrink-0 bg-gray-1 border-gray-7"
			}
		>
			{checked && (
				<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
					<path
						d="M2.5 6.4 5 8.8l4.5-5.4"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			)}
		</span>
	);
}

const markdownComponents: ComponentProps<typeof ReactMarkdown>["components"] = {
	a: ({ node: _node, ...props }) => (
		<a {...props} target="_blank" rel="noopener noreferrer nofollow" />
	),
	input: ({ node: _node, ...props }) =>
		props.type === "checkbox" ? (
			<TaskMark checked={props.checked === true} />
		) : null,
};

function NoteMarkdown({ children }: { children: string }) {
	return (
		<div className={PROSE_CLASS}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				disallowedElements={["img"]}
				components={markdownComponents}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}

export function NoteDocument({
	summaryMarkdown,
	notesMarkdown,
	participants,
	meetingStartedAt,
	duration,
	ownerName,
}: {
	summaryMarkdown: string | null;
	notesMarkdown: string | null;
	participants: string[];
	meetingStartedAt: Date | null;
	duration: number | null;
	ownerName: string | null;
}) {
	const summary = summaryMarkdown?.trim() ?? "";
	const ownNotes = notesMarkdown?.trim() ?? "";
	const shownParticipants = participants.slice(0, SHOWN_PARTICIPANTS);
	const moreParticipants = participants.length - shownParticipants.length;
	const people =
		shownParticipants.length > 0
			? `${shownParticipants.join(", ")}${moreParticipants > 0 ? ` +${moreParticipants}` : ""}`
			: null;
	const hasDetails = Boolean(meetingStartedAt || duration || people);

	return (
		<article className="px-5 py-6 bg-white rounded-2xl border border-gray-5 sm:px-10 sm:py-9">
			<div className="mx-auto w-full max-w-[44rem]">
				{hasDetails && (
					<p className="flex flex-wrap gap-y-1 gap-x-2 items-center pb-5 mb-6 text-[13px] leading-5 border-b text-gray-10 border-gray-4">
						{meetingStartedAt && (
							<NoteMeetingTime iso={meetingStartedAt.toISOString()} />
						)}
						{meetingStartedAt && duration ? (
							<span aria-hidden className="text-gray-7">
								·
							</span>
						) : null}
						{duration ? <span>{formatMeetingLength(duration)}</span> : null}
						{people && (meetingStartedAt || duration) ? (
							<span aria-hidden className="hidden text-gray-7 sm:inline">
								·
							</span>
						) : null}
						{people && (
							<span
								title={participants.join(", ")}
								className="basis-full sm:basis-auto"
							>
								{people}
							</span>
						)}
					</p>
				)}
				{summary && <NoteMarkdown>{summary}</NoteMarkdown>}
				{ownNotes && (
					<section
						className={summary ? "pt-6 mt-8 border-t border-gray-4" : undefined}
					>
						<h2 className="mb-2 text-lg font-medium text-gray-12">
							{ownerName ? `Notes from ${ownerName}` : "Notes"}
						</h2>
						<NoteMarkdown>{ownNotes}</NoteMarkdown>
					</section>
				)}
				{!summary && !ownNotes && (
					<p className="text-sm text-gray-10">This note is empty.</p>
				)}
			</div>
		</article>
	);
}
