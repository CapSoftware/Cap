import { Button } from "@cap/ui";
import { useEffect, useRef } from "react";

export const NoMicrophonePrompt = ({
	isRequesting,
	onTurnOnMicrophone,
	onRecordWithout,
}: {
	isRequesting: boolean;
	onTurnOnMicrophone: () => void;
	onRecordWithout: () => void;
}) => {
	const turnOnButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		turnOnButtonRef.current?.focus();
	}, []);

	return (
		<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-3 text-xs text-amber-12">
			<div role="alert">
				<p className="font-medium">Record without a microphone?</p>
				<p className="mt-1 leading-snug">Your voice won’t be recorded.</p>
			</div>
			<div className="mt-3 flex flex-col gap-2">
				<Button
					ref={turnOnButtonRef}
					type="button"
					variant="blue"
					size="sm"
					disabled={isRequesting}
					onClick={onTurnOnMicrophone}
				>
					Turn on microphone
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={isRequesting}
					onClick={onRecordWithout}
				>
					Record without microphone
				</Button>
			</div>
		</div>
	);
};
