import {
  datetime,
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

export const accounts = mysqlTable(
  'accounts',
  {
    id: varchar('id', { length: 255 }).primaryKey().notNull(),
    userId: varchar('userId', { length: 255 }).notNull(),
    type: varchar('type', { length: 255 }).notNull(),
    provider: varchar('provider', { length: 255 }).notNull(),
    providerAccountId: varchar('providerAccountId', { length: 255 }).notNull(),
    access_token: text('access_token'),
    expires_in: int('expires_in'),
    id_token: text('id_token'),
    refresh_token: text('refresh_token'),
    refresh_token_expires_in: int('refresh_token_expires_in'),
    scope: varchar('scope', { length: 255 }),
    token_type: varchar('token_type', { length: 255 }),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  },
  account => ({
    providerProviderAccountIdIndex: uniqueIndex(
      'accounts__provider__providerAccountId__idx'
    ).on(account.provider, account.providerAccountId),
    userIdIndex: index('accounts__userId__idx').on(account.userId),
  })
);

export const sessions = mysqlTable(
  'sessions',
  {
    id: varchar('id', { length: 255 }).primaryKey().notNull(),
    sessionToken: varchar('sessionToken', { length: 255 }).notNull(),
    userId: varchar('userId', { length: 255 }).notNull(),
    expires: datetime('expires').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  session => ({
    sessionTokenIndex: uniqueIndex('sessions__sessionToken__idx').on(
      session.sessionToken
    ),
    userIdIndex: index('sessions__userId__idx').on(session.userId),
  })
);

export const users = mysqlTable(
  'users',
  {
    id: varchar('id', { length: 255 }).primaryKey().notNull(),
    name: varchar('name', { length: 255 }),
    email: varchar('email', { length: 255 }).notNull(),
    emailVerified: timestamp('emailVerified'),
    image: varchar('image', { length: 255 }),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  user => ({
    emailIndex: uniqueIndex('users__email__idx').on(user.email),
  })
);

export const verificationTokens = mysqlTable(
  'verification_tokens',
  {
    identifier: varchar('identifier', { length: 255 }).primaryKey().notNull(),
    token: varchar('token', { length: 255 }).notNull(),
    expires: datetime('expires').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  verificationToken => ({
    tokenIndex: uniqueIndex('verification_tokens__token__idx').on(
      verificationToken.token
    ),
  })
);