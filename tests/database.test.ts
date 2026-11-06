import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';

const therapistId = '10000000-0000-4000-8000-000000000001';
const otherTherapistId = '10000000-0000-4000-8000-000000000002';
const conversationA = '40000000-0000-4000-8000-000000000001';
const conversationB = '40000000-0000-4000-8000-000000000002';
let local: Awaited<ReturnType<typeof createLocalDatabase>>;
let repository: ClinicRepository;
let slots: Record<string, unknown>[];
const select = (conversation = conversationA, slot = String(slots[0]!.id)) => repository.selectSlot(conversation, slot);
const book = (key = 'test-request-001', conversation = conversationA, slot = String(slots[0]!.id)) => repository.book(conversation, slot, key, true);
const count = async (table: string) => Number((await local.db.query(`select count(*) as count from ${table}`)).rows[0]!.count);

beforeAll(async () => { local = await createLocalDatabase(); repository = new ClinicRepository(local.db); });
afterAll(async () => { await local.db.close(); });
beforeEach(async () => {
  await local.engine.exec('truncate auth.users, public.clinics, public.therapists, public.patients restart identity cascade;');
  await seedLocal(local.engine);
  const range = await repository.regenerate(therapistId, '2030-01-07', 1);
  slots = await repository.getAvailability(therapistId, range.from, range.to);
});

describe('real PostgreSQL booking transactions', () => {
  it('requires an explicit confirmation bound to a selected slot', async () => {
    await expect(book()).rejects.toThrow('CONFIRMATION_REQUIRED');
    await select();
    await expect(repository.book(conversationA, String(slots[0]!.id), 'test-request-001', false)).rejects.toThrow('CONFIRMATION_REQUIRED');
    await expect(book('test-request-001', conversationA, String(slots[1]!.id))).rejects.toThrow('CONFIRMATION_REQUIRED');
    expect(await count('public.appointments')).toBe(0);
  });
  it('rejects expired confirmation', async () => {
    await select();
    await local.db.query("update public.conversations set pending_expires_at = now() - interval '1 second' where id = $1", [conversationA]);
    await expect(book()).rejects.toThrow('CONFIRMATION_REQUIRED');
  });
  it('resolves the patient server-side and creates delivery jobs atomically', async () => {
    await select();
    const result = await book();
    expect(result.patient_id).toBe('20000000-0000-4000-8000-000000000001');
    expect(await count('public.appointments')).toBe(1);
    expect(await count('private.delivery_jobs')).toBe(2);
    expect(await count('private.audit_events')).toBe(1);
  });
  it('deduplicates retries and rejects reuse of a key with another slot', async () => {
    await select();
    const first = await book();
    expect((await book()).id).toBe(first.id);
    await expect(book('test-request-001', conversationA, String(slots[1]!.id))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await count('private.delivery_jobs')).toBe(2);
  });
  it('accepts only one competing booking (embedded engine serializes queries)', async () => {
    await select(conversationA);
    await select(conversationB);
    const results = await Promise.allSettled([book('request-a', conversationA), book('request-b', conversationB)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await count('public.appointments')).toBe(1);
  });
  it('database constraints reject overlapping appointments including buffer', async () => {
    await select();
    const first = await book();
    const overlappingSlot = (await local.db.query(`insert into public.slots(therapist_id, starts_at, ends_at, busy_ends_at)
      values ($1, '2030-01-07T14:50:00Z', '2030-01-07T15:35:00Z', '2030-01-07T15:50:00Z') returning id`, [therapistId])).rows[0]!.id;
    await expect(local.db.query(`insert into public.appointments(conversation_id, patient_id, therapist_id, slot_id,
      starts_at, ends_at, busy_ends_at, request_key) values ($1, $2, $3, $4,
      '2030-01-07T14:50:00Z', '2030-01-07T15:35:00Z', '2030-01-07T15:50:00Z', 'overlap-request')`,
    [conversationB, first.patient_id, therapistId, overlappingSlot])).rejects.toMatchObject({ code: '23P01' });
  });
  it('permits adjacent appointments after the reserved buffer', async () => {
    await select(); await book();
    await select(conversationB, String(slots[1]!.id));
    await book('second-request', conversationB, String(slots[1]!.id));
    expect(await count('public.appointments')).toBe(2);
  });
  it('rejects a slot that became inactive or moved into the past', async () => {
    await select();
    await local.db.query('update public.slots set active = false where id = $1', [slots[0]!.id]);
    await expect(book()).rejects.toThrow('SLOT_UNAVAILABLE');
    await local.db.query("update public.slots set active = true, starts_at = now() - interval '1 minute' where id = $1", [slots[0]!.id]);
    await expect(book()).rejects.toThrow('SLOT_UNAVAILABLE');
  });
  it('regeneration preserves existing bookings and retires obsolete open slots', async () => {
    await select(); const first = await book();
    await local.db.query('update public.availability_rules set start_minute = 780 where therapist_id = $1', [therapistId]);
    await local.db.query('delete from public.availability_breaks where rule_id in (select id from public.availability_rules where therapist_id = $1)', [therapistId]);
    await repository.regenerate(therapistId, '2030-01-07', 1);
    expect((await local.db.query('select * from public.appointments')).rows[0]!.id).toBe(first.id);
    expect((await local.db.query('select active from public.slots where id = $1', [slots[1]!.id])).rows[0]!.active).toBe(false);
  });
  it('rolls back the appointment if creating its delivery jobs fails', async () => {
    await select();
    await local.engine.exec(`create function private.fail_delivery() returns trigger language plpgsql as $$ begin raise exception 'test failure'; end $$;
      create trigger fail_delivery before insert on private.delivery_jobs for each row execute function private.fail_delivery();`);
    try {
      await expect(book()).rejects.toThrow('test failure');
      expect(await count('public.appointments')).toBe(0);
      expect(await count('private.audit_events')).toBe(0);
    } finally { await local.engine.exec('drop trigger fail_delivery on private.delivery_jobs; drop function private.fail_delivery();'); }
  });
});

describe('human handoff', () => {
  it('creates one open case and one notification, and blocks agent booking', async () => {
    await select();
    const first = await repository.escalate(conversationA, 'requested_human');
    expect((await repository.escalate(conversationA, 'requested_human')).id).toBe(first.id);
    await expect(book()).rejects.toThrow('AGENT_PAUSED');
    await expect(select()).rejects.toThrow('AGENT_PAUSED');
    expect(await count('public.handoffs')).toBe(1);
    expect(await count('private.delivery_jobs')).toBe(1);
  });
});

describe('RLS and function privileges', () => {
  async function withUser(role: 'anon' | 'authenticated', userId: string, callback: () => Promise<void>) {
    await local.engine.exec(`set role ${role}`);
    await local.db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    try { await callback(); } finally { await local.engine.exec('reset role'); }
  }
  it('enables RLS on every application table', async () => {
    const rows = (await local.db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`)).rows;
    expect(rows).toEqual([]);
  });
  it('denies anonymous access to patient data', async () => {
    await withUser('anon', '', async () => { await expect(local.db.query('select * from public.patients')).rejects.toMatchObject({ code: '42501' }); });
  });
  it('authenticated users without staff membership see no patient or schedule rows', async () => {
    await withUser('authenticated', '90000000-0000-4000-8000-000000000001', async () => {
      expect((await local.db.query('select * from public.patients')).rows).toEqual([]);
      expect((await local.db.query('select * from public.slots')).rows).toEqual([]);
    });
  });
  it('limits a therapist to their own schedule and denies backend-only functions', async () => {
    const user = '90000000-0000-4000-8000-000000000001';
    await local.db.query('insert into auth.users(id) values ($1)', [user]);
    await local.db.query("insert into public.staff_members(user_id, role) values ($1, 'therapist')", [user]);
    await local.db.query('update public.therapists set staff_user_id = $1 where id = $2', [user, therapistId]);
    await repository.regenerate(otherTherapistId, '2030-01-07', 1);
    await withUser('authenticated', user, async () => {
      expect((await local.db.query('select distinct therapist_id from public.slots')).rows).toEqual([{ therapist_id: therapistId }]);
      expect((await local.db.query('select * from public.patients')).rows).toEqual([]);
      await expect(local.db.query('select * from private.book_slot($1, $2, $3, true)', [conversationA, slots[0]!.id, 'untrusted-request'])).rejects.toMatchObject({ code: '42501' });
      await expect(local.db.query('select * from private.delivery_jobs')).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('allows reception to read bookings and cases, but not write appointments directly', async () => {
    const user = '90000000-0000-4000-8000-000000000002';
    await local.db.query('insert into auth.users(id) values ($1)', [user]);
    await local.db.query("insert into public.staff_members(user_id, role) values ($1, 'reception')", [user]);
    await select(); await book(); await repository.escalate(conversationA, 'requested_human');
    await withUser('authenticated', user, async () => {
      expect(await count('public.appointments')).toBe(1);
      expect(await count('public.handoffs')).toBe(1);
      await expect(local.db.query("update public.appointments set status = 'cancelled'")).rejects.toMatchObject({ code: '42501' });
    });
  });
});
