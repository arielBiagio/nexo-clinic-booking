import type { Sql } from './client.js';

/** Repository operations keep their rollback boundary inside a conversation transaction. */
export function withSavepoints(db: Sql): Sql {
  let next = 0;
  const scoped: Sql = {
    query: (text, values) => db.query(text, values),
    async transaction(operation) {
      const name = `chat_operation_${++next}`;
      await db.query(`savepoint ${name}`);
      try {
        const result = await operation(scoped);
        await db.query(`release savepoint ${name}`);
        return result;
      } catch (error) {
        await db.query(`rollback to savepoint ${name}`);
        await db.query(`release savepoint ${name}`);
        throw error;
      }
    },
    close: async () => {},
  };
  return scoped;
}
