import { expect, it, vi } from 'vitest';
import { OpenRouterModel } from '../packages/agent/src/openrouter.js';
import { narrationPrompt, renderNarration, type NarrationContext } from '../packages/agent/src/narration.js';
const context:NarrationContext={event:'availability',request:'Quiero fisio el lunes a las 9h',facts:{exact_time_status:'unavailable',search_complete:true,offered_count:3,alternatives_to_exact_time:true,therapist_scope:'all therapists',period_days:1},variables:{requested_time:'09:00',day:'lunes'},requiredVariables:['requested_time','day']};
it('uses a compact event-specific prompt and a bounded writer without tools',async()=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'El {day} a las {requested_time} no hay turnos disponibles. Te muestro alternativas.'}}]})));
  const model=new OpenRouterModel('qa-not-a-real-key',{fetch:transport});const draft=await model.explain(context);
  expect(renderNarration(draft,context)).toContain('lunes a las 09:00');
  const body=JSON.parse(String(transport.mock.calls[0]![1]!.body));expect(body.tools).toBeUndefined();expect(body.max_tokens).toBe(220);
  expect(body.messages[0].content.length).toBeLessThan(1800);expect(body.messages[0].content).not.toContain('BOOKING SAFETY');
  expect(narrationPrompt({...context,event:'selected'})).not.toContain('exact_time_status=unavailable');
});
it.each(['Tu turno está confirmado.','A las 9:00 está libre.','El {other_day} a las {requested_time}.','Ya envié un correo.','El {day} a las {requested_time} está ocupado.'])('rejects unsupported writer claims: %s',draft=>{expect(renderNarration(draft,context)).toBeNull();});
it('permits a confirmed-booking explanation only after actual booking success',()=>{
  const booked={...context,event:'booked' as const,variables:{},requiredVariables:[]};
  expect(renderNarration('Tu turno quedó confirmado. ¡Te esperamos!',booked)).toBeTruthy();
  expect(renderNarration('Tu turno quedó confirmado.',context)).toBeNull();
});
