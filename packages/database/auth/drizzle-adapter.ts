import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { accounts, sessions, users, verificationTokens } from '../schema';
import type { Adapter } from 'next-auth/adapters';
import type { PlanetScaleDatabase } from 'drizzle-orm/planetscale-serverless';

export function DrizzleAdapter(db: PlanetScaleDatabase): Adapter {
  return {
    async createUser(userData) {
      await db.insert(users).values({
        id: createId(),
        email: userData.email,
        emailVerified: userData.emailVerified,
        name: userData.name,
        image: userData.image,
      });
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, userData.email))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('User not found');
      return row;
    },
    async getUser(id) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      return row ?? null;
    },
    async getUserByEmail(email) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = rows[0];
      return row ?? null;
    },
    async getUserByAccount({ providerAccountId, provider }) {
      const rows = await db
        .select()
        .from(users)
        .innerJoin(accounts, eq(users.id, accounts.userId))
        .where(
          and(
            eq(accounts.providerAccountId, providerAccountId),
            eq(accounts.provider, provider)
          )
        )
        .limit(1);
      const row = rows[0];
      return row?.users ?? null;
    },
    async updateUser({ id, ...userData }) {
      if (!id) throw new Error('User not found');
      await db.update(users).set(userData).where(eq(users.id, id));
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('User not found');
      return row;
    },
    async deleteUser(userId) {
      await db.delete(users).where(eq(users.id, userId));
    },
    async linkAccount(account) {
      await db.insert(accounts).values({
        id: createId(),
        userId: account.userId,
        type: account.type,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        access_token: account.access_token,
        expires_in: account.expires_in as number,
        id_token: account.id_token,
        refresh_token: account.refresh_token,
        refresh_token_expires_in: account.refresh_token_expires_in as number,
        scope: account.scope,
        token_type: account.token_type,
      });
    },
    async unlinkAccount({ providerAccountId, provider }) {
      await db
        .delete(accounts)
        .where(
          and(
            eq(accounts.providerAccountId, providerAccountId),
            eq(accounts.provider, provider)
          )
        );
    },
    async createSession(data) {
      await db.insert(sessions).values({
        id: createId(),
        expires: data.expires,
        sessionToken: data.sessionToken,
        userId: data.userId,
      });
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionToken, data.sessionToken))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('User not found');
      return row;
    },
    async getSessionAndUser(sessionToken) {
      const rows = await db
        .select({
          user: users,
          session: {
            id: sessions.id,
            userId: sessions.userId,
            sessionToken: sessions.sessionToken,
            expires: sessions.expires,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.sessionToken, sessionToken))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const { user, session } = row;
      return {
        user,
        session: {
          id: session.id,
          userId: session.userId,
          sessionToken: session.sessionToken,
          expires: session.expires,
        },
      };
    },
    async updateSession(session) {
      await db
        .update(sessions)
        .set(session)
        .where(eq(sessions.sessionToken, session.sessionToken));
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionToken, session.sessionToken))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('Coding bug: updated session not found');
      return row;
    },
    async deleteSession(sessionToken) {
      await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
    },
    async createVerificationToken(verificationToken) {
      await db.insert(verificationTokens).values({
        expires: verificationToken.expires,
        identifier: verificationToken.identifier,
        token: verificationToken.token,
      });
      const rows = await db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.token, verificationToken.token))
        .limit(1);
      const row = rows[0];
      if (!row)
        throw new Error('Coding bug: inserted verification token not found');
      return row;
    },
    async useVerificationToken({ identifier, token }) {
      const rows = await db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.token, token))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      await db
        .delete(verificationTokens)
        .where(
          and(
            eq(verificationTokens.token, token),
            eq(verificationTokens.identifier, identifier)
          )
        );
      return row;
    },
  };
}