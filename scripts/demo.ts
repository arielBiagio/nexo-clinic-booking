import { Temporal } from '@js-temporal/polyfill';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';

const { db, engine } = await createLocalDatabase();
try {
  await seedLocal(engine);
  const repository = new ClinicRepository(db);
  const therapist = (await repository.getTherapists())[0]!;
  const today = Temporal.Now.plainDateISO('America/New_York');
  const range = await repository.regenerate(String(therapist.id), today.toString(), 14);
  const slots = await repository.getAvailability(String(therapist.id), range.from, range.to);
  const slot = slots[0]!;
  const conversationId = '40000000-0000-4000-8000-000000000001';
  console.log('1. Horarios generados:', range.generated);
  console.log('2. Selección para confirmar:', await repository.selectSlot(conversationId, String(slot.id)));
  const appointment = await repository.book(conversationId, String(slot.id), 'demo-booking-001', true);
  const retry = await repository.book(conversationId, String(slot.id), 'demo-booking-001', true);
  console.log('3. Reserva creada:', appointment.id);
  console.log('4. Reintento devuelve la misma cita:', appointment.id === retry.id);
  await repository.escalate(conversationId, 'requested_human');
  try {
    await repository.selectSlot(conversationId, String(slots[1]!.id));
  } catch (error) { console.log('5. Agente pausado:', (error as Error).message); }
  console.log('6. Entregas pendientes (sin enviar):', (await db.query('select destination, status from private.delivery_jobs')).rows);
} finally { await db.close(); }
