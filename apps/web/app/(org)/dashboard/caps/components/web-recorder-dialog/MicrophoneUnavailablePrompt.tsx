import { Button } from "@cap/ui";
import { useEffect, useRef } from "react";

export const MicrophoneUnavailablePrompt = ({
	onRespond,
}: {
	onRespond: (proceed: boolean) => void;
}) => {
	const backButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		backButtonRef.current?.focus();
	}, []);

	return (
		<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-3 text-xs text-amber-12">
			<div role="alert">
				<p className="font-medium">Microphone unavailable</p>
				<p className="mt-1 leading-snug">
					Recording hasn’t started. Go back to check permissions or choose
					another microphone, or continue without recording your voice.
				</p>
			</div>
			<div className="mt-3 flex flex-col gap-2">
				<Button
					ref={backButtonRef}
					type="button"
					variant="outline"
					size="sm"
					onClick={() => onRespond(false)}
				>
					Go back
				</Button>
				<Button
					type="button"
					variant="blue"
					size="sm"
					onClick={() => onRespond(true)}
				>
					Record without microphone
				</Button>
			</div>
		</div>
	);
};
