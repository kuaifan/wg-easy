import { eq, sql } from 'drizzle-orm';
import { upstreamServer } from './schema';
import type { CreateUpstreamType, UpdateUpstreamType } from './types';
import type { DBType } from '#db/sqlite';

function createPreparedStatement(db: DBType) {
  return {
    findAll: db.query.upstreamServer.findMany().prepare(),
    findAllEnabled: db.query.upstreamServer
      .findMany({
        where: eq(upstreamServer.enabled, true),
      })
      .prepare(),
    findById: db.query.upstreamServer
      .findFirst({ where: eq(upstreamServer.id, sql.placeholder('id')) })
      .prepare(),
    toggle: db
      .update(upstreamServer)
      .set({ enabled: sql.placeholder('enabled') as never as boolean })
      .where(eq(upstreamServer.id, sql.placeholder('id')))
      .prepare(),
    delete: db
      .delete(upstreamServer)
      .where(eq(upstreamServer.id, sql.placeholder('id')))
      .prepare(),
  };
}

export class UpstreamService {
  #db: DBType;
  #statements: ReturnType<typeof createPreparedStatement>;

  constructor(db: DBType) {
    this.#db = db;
    this.#statements = createPreparedStatement(db);
  }

  async getAll() {
    const result = await this.#statements.findAll.execute();
    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  async getAllEnabled() {
    const result = await this.#statements.findAllEnabled.execute();
    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  get(id: ID) {
    return this.#statements.findById.execute({ id });
  }

  async create(data: CreateUpstreamType) {
    // Generate unique interface name
    const upstreams = await this.getAll();
    const interfaceName = `wg-up-${upstreams.length + 1}`;

    return await this.#db
      .insert(upstreamServer)
      .values({
        ...data,
        interfaceName,
      })
      .returning()
      .execute();
  }

  async update(id: ID, data: UpdateUpstreamType) {
    return await this.#db
      .update(upstreamServer)
      .set(data)
      .where(eq(upstreamServer.id, id))
      .execute();
  }

  toggle(id: ID, enabled: boolean) {
    return this.#statements.toggle.execute({ id, enabled });
  }

  delete(id: ID) {
    return this.#statements.delete.execute({ id });
  }
}
