import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(callback: (db: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function connectPostgres(connectionString: string): Sql {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  // Idle sockets may be reset by the network; pg removes them and reconnects on demand.
  // Never log the provider error: it can contain connection details or SQL.
  pool.on('error', () => console.warn('Base de datos: se perdió una conexión inactiva; se abrirá otra cuando sea necesaria.'));
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(callback) {
      const client = await pool.connect();
      let broken=false;
      const onConnectionError=()=>{broken=true;};
      // A checked-out client can fail between queries while awaiting another operation.
      client.on('error',onConnectionError);
      const transaction: Sql = {
        query: (text, values) => client.query(text, values),
        transaction: () => { throw new Error('Nested transaction not supported'); },
        close: async () => {},
      };
      try {
        await client.query('begin');
        const result = await callback(transaction);
        await client.query('commit');
        return result;
      } catch (error) {
        try{await client.query('rollback');}catch{broken=true;}
        throw error;
      } finally {client.removeListener('error',onConnectionError);client.release(broken);}
    },
    close: () => pool.end(),
  };
}

export async function createLocalDatabase(options:{dataDir?:string}={}): Promise<{ db: Sql; engine: PGlite }> {
  const engine = new PGlite({ ...options, extensions: { btree_gist } });
  await engine.waitReady;
  // Only the local PostgreSQL harness supplies auth primitives. Never run this on Supabase.
  const initialized=(await engine.query("select 1 from pg_namespace where nspname='auth'")).rows.length>0;
  if(!initialized)await engine.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  await engine.exec('create schema if not exists local_harness; create table if not exists local_harness.migrations(name text primary key)');
  const applied=new Set((await engine.query<{name:string}>('select name from local_harness.migrations')).rows.map(r=>r.name));
  const migrationsPath = resolve('supabase/migrations');
  for (const file of (await readdir(migrationsPath)).filter(name => name.endsWith('.sql')).sort()) {
    if(applied.has(file))continue;
    const sql=await readFile(resolve(migrationsPath,file),'utf8');
    await engine.transaction(async tx=>{await tx.exec(sql);await tx.query('insert into local_harness.migrations(name) values ($1)',[file]);});
  }
  const wrap = (client: Pick<PGlite, 'query'>, root = false): Sql => ({
    query: (text, values) => client.query(text, values),
    transaction: callback => {
      if (!root) throw new Error('Nested transaction not supported');
      return engine.transaction(tx => callback(wrap(tx)));
    },
    close: () => engine.close(),
  });
  return { db: wrap(engine, true), engine };
}

export async function seedLocal(engine: PGlite) {
  await engine.exec(await readFile(resolve('supabase/seed.sql'), 'utf8'));
}
