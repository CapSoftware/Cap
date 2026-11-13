const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const GUILD_INSTALL = "0";

export type ReleaseInvocation = {
	guild_id?: string;
	member?: { permissions?: string };
	authorizing_integration_owners?: Partial<Record<string, string>>;
};

export function isGuildInvocation(interaction: ReleaseInvocation) {
	if (typeof interaction.guild_id !== "string" || !interaction.guild_id)
		return false;
	if (!interaction.member) return false;

	const owners = interaction.authorizing_integration_owners;
	if (owners && owners[GUILD_INSTALL] !== interaction.guild_id) return false;

	return true;
}

export function canManageGuild(permissions: unknown) {
	if (typeof permissions !== "string" || !/^\d+$/.test(permissions))
		return false;

	return (BigInt(permissions) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}

export function matchesRepositoryClaims(
	payload: Record<string, unknown>,
	owner: string,
	repo: string,
) {
	return (
		payload.repository === `${owner}/${repo}` &&
		payload.repository_owner === owner
	);
}
