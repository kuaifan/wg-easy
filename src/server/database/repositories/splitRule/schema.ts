import { sql, relations } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { client } from '../client/schema';

export const splitRule = sqliteTable('split_rules', {
  id: int().primaryKey({ autoIncrement: true }),
  clientId: int('client_id')
    .notNull()
    .references(() => client.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    }),
  ruleType: text('rule_type').notNull(), // 'domain' | 'ip'
  ruleValue: text('rule_value').notNull(),
  action: text().default('proxy').notNull(), // 'proxy' | 'direct'
  enabled: int({ mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});

export const splitRuleRelations = relations(splitRule, ({ one }) => ({
  client: one(client, {
    fields: [splitRule.clientId],
    references: [client.id],
  }),
}));
