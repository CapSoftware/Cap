export const NO_MICROPHONE_CONFIRMED_KEY =
	"cap-web-recorder-no-microphone-confirmed";

let confirmedInMemory = false;

export const hasConfirmedNoMicrophone = () => {
	if (confirmedInMemory) return true;
	try {
		return (
			window.sessionStorage.getItem(NO_MICROPHONE_CONFIRMED_KEY) === "true"
		);
	} catch {
		return false;
	}
};

export const rememberNoMicrophoneConfirmed = () => {
	confirmedInMemory = true;
	try {
		window.sessionStorage.setItem(NO_MICROPHONE_CONFIRMED_KEY, "true");
	} catch {}
};

export const shouldConfirmNoMicrophone = ({
	micEnabled,
	micExplicitlyOff,
}: {
	micEnabled: boolean;
	micExplicitlyOff: boolean;
}) => !micEnabled && !micExplicitlyOff && !hasConfirmedNoMicrophone();
