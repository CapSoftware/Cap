export const TOO_MANY_PASSWORD_ATTEMPTS =
	"Too many attempts. Please try again later.";

const PASSWORD_RESOURCE_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function passwordAttemptResourceKey(id: string): string | null {
	return PASSWORD_RESOURCE_ID.test(id) ? id.toLowerCase() : null;
}
