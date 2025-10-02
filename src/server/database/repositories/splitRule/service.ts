import { eq, and, sql } from 'drizzle-orm';
import { splitRule } from './schema';
import type { CreateSplitRuleType, UpdateSplitRuleType } from './types';
import type { DBType } from '#db/sqlite';

function createPreparedStatement(db: DBType) {
  return {
    findByClientId: db.query.splitRule
      .findMany({
        where: eq(splitRule.clientId, sql.placeholder('clientId')),
      })
      .prepare(),
    findById: db.query.splitRule
      .findFirst({ where: eq(splitRule.id, sql.placeholder('id')) })
      .prepare(),
    toggle: db
      .update(splitRule)
      .set({ enabled: sql.placeholder('enabled') as never as boolean })
      .where(eq(splitRule.id, sql.placeholder('id')))
      .prepare(),
    delete: db
      .delete(splitRule)
      .where(eq(splitRule.id, sql.placeholder('id')))
      .prepare(),
  };
}

export class SplitRuleService {
  #db: DBType;
  #statements: ReturnType<typeof createPreparedStatement>;

  constructor(db: DBType) {
    this.#db = db;
    this.#statements = createPreparedStatement(db);
  }

  async getByClientId(clientId: ID) {
    const result = await this.#statements.findByClientId.execute({ clientId });
    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  get(id: ID) {
    return this.#statements.findById.execute({ id });
  }

  async create(data: CreateSplitRuleType) {
    return await this.#db
      .insert(splitRule)
      .values(data)
      .returning()
      .execute();
  }

  async update(id: ID, data: UpdateSplitRuleType) {
    return await this.#db
      .update(splitRule)
      .set(data)
      .where(eq(splitRule.id, id))
      .execute();
  }

  toggle(id: ID, enabled: boolean) {
    return this.#statements.toggle.execute({ id, enabled });
  }

  delete(id: ID) {
    return this.#statements.delete.execute({ id });
  }
}
