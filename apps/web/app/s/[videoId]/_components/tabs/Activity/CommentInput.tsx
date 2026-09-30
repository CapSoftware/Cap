import { Button } from "@cap/ui";
import type React from "react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface CommentInputProps {
	onSubmit?: (content: string) => void;
	onCancel?: () => void;
	placeholder?: string;
	showCancelButton?: boolean;
	buttonLabel?: string;
	autoFocus?: boolean;
	disabled?: boolean;
	/** Rendered to the left of the field, e.g. the viewer's avatar. */
	avatar?: ReactNode;
	/** Rendered to the right of the field, e.g. the record buttons. */
	actions?: ReactNode;
	/**
	 * Idles as a single line and only grows (and reveals its submit button) once
	 * it has focus or content. The panel composer uses this so sitting at the top
	 * of the sidebar costs one row; replies keep the always-open form.
	 */
	collapsible?: boolean;
}

const CommentInput: React.FC<CommentInputProps> = ({
	onSubmit,
	onCancel,
	placeholder,
	showCancelButton = false,
	buttonLabel = "Reply",
	autoFocus = false,
	disabled,
	avatar,
	actions,
	collapsible = false,
}) => {
	const [content, setContent] = useState("");
	const [focused, setFocused] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
		}
	}, [autoFocus]);

	const expanded = !collapsible || focused || content.length > 0;

	const handleSubmit = (e?: React.FormEvent) => {
		e?.preventDefault();
		if (content.trim()) {
			onSubmit?.(content);
			setContent("");
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="flex items-start space-x-3">
			<div className="flex-1">
				<div className="flex items-start gap-2 p-2 rounded-lg border bg-gray-1 border-gray-5 focus-within:border-gray-6">
					{avatar && <div className="shrink-0">{avatar}</div>}
					<div className="flex-1 min-w-0">
						{/* Two rows even at idle: a one-line sliver reads as a search box,
						    and this field is the sidebar's whole point. Focus grows it to
						    a proper drafting area. */}
						<textarea
							ref={inputRef}
							value={content}
							disabled={disabled}
							rows={expanded ? 3 : 2}
							onChange={(e) => setContent(e.target.value)}
							onKeyDown={handleKeyDown}
							onFocus={() => setFocused(true)}
							onBlur={() => setFocused(false)}
							placeholder={placeholder || "Leave a comment..."}
							className="w-full resize-none placeholder:text-gray-8 text-sm leading-[22px] text-gray-12 bg-transparent focus:outline-none"
						/>
						{expanded && (
							<div className="flex items-center mt-2 space-x-2">
								<Button
									size="xs"
									variant="primary"
									onClick={() => handleSubmit()}
									disabled={!content}
								>
									{buttonLabel}
								</Button>
								{showCancelButton && onCancel && (
									<Button size="xs" variant="outline" onClick={onCancel}>
										Cancel
									</Button>
								)}
							</div>
						)}
					</div>
					{/* preventDefault on the way down: the field is often focused when
					    one of these is pressed, and a blur first would collapse the row
					    out from under the click. */}
					{actions && (
						<div
							className="flex shrink-0 items-center gap-0.5"
							onPointerDown={(event) => event.preventDefault()}
						>
							{actions}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

export default CommentInput;
