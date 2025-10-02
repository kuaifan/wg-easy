import { sql, relations } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { client } from '../client/schema';

export const upstreamServer = sqliteTable('upstream_servers', {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  interfaceName: text('interface_name').notNull().unique(),
  endpoint: text().notNull(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  presharedKey: text('preshared_key'),
  allowedIps: text('allowed_ips', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  persistentKeepalive: int('persistent_keepalive').default(25).notNull(),
  mtu: int().default(1360).notNull(),
  enabled: int({ mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});

export const upstreamRelations = relations(upstreamServer, ({ many }) => ({
  clients: many(client),
}));
