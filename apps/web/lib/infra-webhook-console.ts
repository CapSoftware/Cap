// A signing secret is returned once. While one is on screen, or an add that
// will return one is open or in flight, nothing else that returns a secret may
// start, so no secret replaces another before it is dismissed.
export type InfraWebhookConsoleState = {
	adding: boolean;
	creating: boolean;
	secretShown: boolean;
};

export function infraWebhookLocks(state: InfraWebhookConsoleState) {
	return {
		canAdd: !state.adding && !state.creating && !state.secretShown,
		canRotate: !state.adding && !state.creating && !state.secretShown,
		canDelete: !state.creating,
	};
}
