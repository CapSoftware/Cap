export const NO_MICROPHONE_ANSWERED_KEY =
	"cap-web-recorder-no-microphone-answered";

let answeredInMemory = false;

export const hasAnsweredNoMicrophone = () => {
	if (answeredInMemory) return true;
	try {
		return window.sessionStorage.getItem(NO_MICROPHONE_ANSWERED_KEY) === "true";
	} catch {
		return false;
	}
};

export const rememberNoMicrophoneAnswered = () => {
	answeredInMemory = true;
	try {
		window.sessionStorage.setItem(NO_MICROPHONE_ANSWERED_KEY, "true");
	} catch {}
};

export const shouldConfirmNoMicrophone = ({
	micEnabled,
	micExplicitlyOff,
}: {
	micEnabled: boolean;
	micExplicitlyOff: boolean;
}) => !micEnabled && !micExplicitlyOff && !hasAnsweredNoMicrophone();
