import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/agent-api/src/app.js';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';

const token = 'test-only-token-0123456789-abcdefghijk';
const auth = { authorization: `Bearer ${token}` };
const therapist = '10000000-0000-4000-8000-000000000001';
const conversation = '40000000-0000-4000-8000-000000000001';
let local: Awaited<ReturnType<typeof createLocalDatabase>>;
let app: ReturnType<typeof buildApp>;
let slotId: string;

beforeAll(async () => {
  local = await createLocalDatabase();
  app = buildApp(new ClinicRepository(local.db), token);
  await app.ready();
});
beforeEach(async () => {
  await local.engine.exec('truncate auth.users, public.clinics, public.therapists, public.patients restart identity cascade;');
  await seedLocal(local.engine);
  const repository = new ClinicRepository(local.db);
  const range = await repository.regenerate(therapist, '2030-01-07', 1);
  slotId = String((await repository.getAvailability(therapist, range.from, range.to))[0]!.id);
});
afterAll(async () => { await app.close(); await local.db.close(); });

describe('local operator API contract', () => {
  it('provides a non-sensitive healthcheck without credentials', async () => {
    const response = await app.inject({ url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', mode: 'synthetic-local-demo' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(['/v1/therapists', '/v1/conversations', '/v1/availability'])('requires authorization for %s', async url => {
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: 'Bearer forged' } })).statusCode).toBe(401);
  });
  it('returns synthetic schedules only with operator authorization', async () => {
    const response = await app.inject({ url: `/v1/availability?therapistId=${therapist}&from=2030-01-07T00:00:00Z&to=2030-01-08T00:00:00Z`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(7);
  });
  it('rejects invalid ranges and malformed ids without leaking SQL', async () => {
    for (const suffix of [
      `therapistId=${therapist}&from=2030-01-08T00:00:00Z&to=2030-01-07T00:00:00Z`,
      `therapistId=${therapist}&from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z`,
      'therapistId=invalid&from=tomorrow&to=later',
    ]) {
      const response = await app.inject({ url: `/v1/availability?${suffix}`, headers: auth });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toMatch(/select|stack|node_modules/i);
    }
  });
  it('requires explicit confirmation and an idempotency key', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/book`, headers: auth, payload: { slotId, confirmed: true } });
    expect(response.statusCode).toBe(400);
    const unselected = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/book`, headers: { ...auth, 'idempotency-key': 'request-001' }, payload: { slotId, confirmed: true } });
    expect(unselected.statusCode).toBe(409);
    expect(unselected.json()).toEqual({ error: 'CONFIRMATION_REQUIRED' });
  });
  it('does not allow client-supplied patient identity', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/book`, headers: { ...auth, 'idempotency-key': 'request-001' },
      payload: { slotId, confirmed: true, patientId: '20000000-0000-4000-8000-000000000002' } });
    expect(response.statusCode).toBe(400);
  });
  it('books end-to-end with one appointment across a repeated HTTP request', async () => {
    expect((await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/selection`, headers: auth, payload: { slotId } })).statusCode).toBe(200);
    const request = { method: 'POST' as const, url: `/v1/conversations/${conversation}/book`, headers: { ...auth, 'idempotency-key': 'request-001' }, payload: { slotId, confirmed: true } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });
  it('pauses new agent actions after an HTTP handoff', async () => {
    const handoff = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/handoff`, headers: auth, payload: { reason: 'requested_human' } });
    expect(handoff.statusCode).toBe(200);
    const selection = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/selection`, headers: auth, payload: { slotId } });
    expect(selection.statusCode).toBe(409);
    expect(selection.json()).toEqual({ error: 'AGENT_PAUSED' });
  });
  it('handles malformed JSON and oversized bodies without reflecting payloads', async () => {
    const invalid = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/selection`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"secret":' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('secret');
    const oversized = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation}/selection`, headers: auth, payload: { text: 'x'.repeat(17_000) } });
    expect(oversized.statusCode).toBe(413);
  });
  it('refuses a missing/weak local operator token', () => {
    expect(() => buildApp(new ClinicRepository(local.db), '')).toThrow('DEMO_API_TOKEN');
  });
});
