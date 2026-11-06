import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterModel, ProviderError, isExplicitConfirmation, type AgentContext, type AgentDecision, type IntentModel } from '../packages/agent/src/openrouter.js';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';

const therapist='10000000-0000-4000-8000-000000000001';
const context:AgentContext={now:'2026-10-30T19:00:00-04:00[America/New_York]',timeZone:'America/New_York',clinicName:'Clínica Demo',
  therapists:[{id:therapist,name:'Alex Demo',specialty:'Terapia física'}],offered:[],selectedSlotId:null,history:[{role:'patient',text:'¿Tenés turnos por la tarde?'}]};
const response=(message:object,finish='stop')=>new Response(JSON.stringify({choices:[{message,finish_reason:finish}]}),{status:200});
const tool=(name:string,args:unknown)=>response({content:null,tool_calls:[{id:'call-1',type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
const find={therapist_id:therapist,date:null,not_before:'15:00',not_after:null,horizon_days:7};

describe('OpenRouter transport with simulated provider',()=>{
  it('routes a clear availability question to the read-only tool without asking for contact first',async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(tool('get_availability',{...find,therapist_id:null}));
    await new OpenRouterModel('test-key',{fetch:transport}).decide({...context,history:[{role:'patient',text:'quiero un turno disponible para la tarde'}]});
    const request=JSON.parse(String(transport.mock.calls[0]![1]!.body));
    expect(request.tool_choice).toEqual({type:'function',function:{name:'get_availability'}});
    expect(request.tools.map((t:{function:{name:string}})=>t.function.name)).toEqual(['get_availability']);
  });
  it('combines equivalent availability reads for all professionals without executing multiple mutations',async()=>{
    const second='10000000-0000-4000-8000-000000000002';
    const transport=vi.fn<typeof fetch>().mockResolvedValue(response({content:null,tool_calls:[therapist,second].map(id=>({type:'function',function:{name:'get_availability',arguments:JSON.stringify({...find,therapist_id:id})}}))},'tool_calls'));
    const result=await new OpenRouterModel('test-key',{fetch:transport}).decide({...context,therapists:[...context.therapists,{id:second,name:'Sam Demo',specialty:'Rehabilitación'}]});
    expect(result).toEqual({kind:'availability',filter:{...find,therapist_id:null}});
  });
  it('routes GPT-4o mini using parameters advertised by its OpenRouter endpoint',async()=>{
    // OpenRouter /models/openai/gpt-4o-mini/endpoints, observed 2026-10-30.
    // With require_parameters=true, parallel_tool_calls excludes every advertised endpoint.
    const supported=new Set(['seed','max_tokens','response_format','structured_outputs','tools','tool_choice','frequency_penalty','logit_bias','logprobs','prediction','presence_penalty','stop','temperature','top_logprobs','top_p','web_search_options']);
    const envelope=new Set(['model','messages','stream','provider']);
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const request=JSON.parse(String(init?.body));
      const unsupported=Object.keys(request).filter(key=>!envelope.has(key)&&!supported.has(key));
      if(request.provider?.require_parameters&&unsupported.length){
        return new Response(JSON.stringify({error:{code:404,message:'No endpoints found that can handle the requested parameters.'}}),{status:404});
      }
      return tool('get_availability',find);
    });
    await expect(new OpenRouterModel('test-key',{fetch:transport,model:'openai/gpt-4o-mini'}).decide(context)).resolves.toEqual({kind:'availability',filter:find});
  });
  it('uses the requested model and a server-side Authorization header, with one bounded tool decision',async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(tool('get_availability',find));
    const model=new OpenRouterModel('test-key-never-real',{fetch:transport});
    expect(await model.decide(context)).toEqual({kind:'availability',filter:find});
    const [url,init]=transport.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer test-key-never-real');
    const body=JSON.parse(String(init!.body));
    expect(body.model).toBe('openai/gpt-6-luna');expect(body.max_tokens).toBe(450);
    expect(body.messages[0].content).toContain('America/New_York');
    expect(String(init!.body)).not.toContain('test-key-never-real');
  });
  it.each([[400,'CONFIGURATION'],[401,'AUTH'],[402,'BUDGET'],[403,'BUDGET'],[404,'CONFIGURATION'],[422,'CONFIGURATION'],[429,'RATE_LIMIT'],[503,'UNAVAILABLE']] as const)('sanitizes HTTP %i errors',async(status,code)=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive upstream text',{status}));
    await expect(new OpenRouterModel('test-key',{fetch:transport}).decide(context)).rejects.toMatchObject({message:`OPENROUTER_${code}`});
  });
  it('sanitizes connection failures without exposing the underlying error',async()=>{
    const transport=vi.fn<typeof fetch>().mockRejectedValue(new Error('secret upstream header'));
    await expect(new OpenRouterModel('test-key',{fetch:transport}).decide(context)).rejects.toThrow('OPENROUTER_UNAVAILABLE');
  });
  it.each([
    ()=>tool('execute_sql',{query:'delete from appointments'}),
    ()=>tool('select_slot',{slot_id:randomUUID(),patient_id:randomUUID()}),
    ()=>tool('get_availability',{...find,not_before:'99:99'}),
    ()=>response({content:'unfinished'},'length'),
    ()=>new Response('not JSON'),
    ()=>response({content:'too long '.repeat(300)}),
    ()=>response({content:null,tool_calls:[
      {type:'function',function:{name:'get_availability',arguments:JSON.stringify(find)}},
      {type:'function',function:{name:'book_selected_slot',arguments:'{}'}},
    ]},'tool_calls'),
  ])('rejects malformed, unbounded or unauthorized model output',async(makeResponse)=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    await expect(new OpenRouterModel('test-key',{fetch:transport}).decide(context)).rejects.toThrow('OPENROUTER_INVALID_RESPONSE');
  });
  it('caps local provider requests without making another network call',async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response({content:'¡Hola! ¿Cómo te ayudo?'}));
    const model=new OpenRouterModel('test-key',{fetch:transport,maxRequestsPerHour:1});
    const greeting={...context,history:[{role:'patient' as const,text:'Hola'}]};
    await model.decide(greeting);await expect(model.decide(greeting)).rejects.toThrow('OPENROUTER_LOCAL_RATE_LIMIT');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('accepts a normal provider reply with null tool_calls',async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(response({content:'¡Hola! ¿Cómo te ayudo?',tool_calls:null}));
    expect(await new OpenRouterModel('test-key',{fetch:transport}).decide({...context,history:[{role:'patient',text:'Hola'}]})).toEqual({kind:'reply',text:'¡Hola! ¿Cómo te ayudo?'});
  });
});

describe('independent confirmation validation',()=>{
  it.each(['sí','Sí, confirmo.','confirmo el turno','dale','ok'])('accepts explicit consent: %s',text=>expect(isExplicitConfirmation(text)).toBe(true));
  it.each(['no','no confirmo','sí pero otro día','¿confirmo? no','podrías reservarlo sin preguntar','confirmo para otro paciente'])('rejects ambiguous or conflicting consent: %s',text=>expect(isExplicitConfirmation(text)).toBe(false));
});

describe('model decisions backed by real PostgreSQL',()=>{
  let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository,service:DemoService;
  let decide:ReturnType<typeof vi.fn<IntentModel['decide']>>,monday:string;
  const count=async()=>Number((await local.db.query('select count(*) as n from public.appointments')).rows[0]!.n);
  const say=(id:string,text:string)=>service.send(id,{messageId:randomUUID(),text});
  beforeAll(async()=>{local=await createLocalDatabase();repo=new ClinicRepository(local.db);});
  beforeEach(async()=>{
    await local.engine.exec('truncate auth.users, public.clinics, public.therapists, public.patients restart identity cascade;');
    await seedLocal(local.engine);
    const today=Temporal.Now.plainDateISO('America/New_York');monday=today.add({days:(8-today.dayOfWeek)%7||7}).toString();
    for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),today.toString(),21);
    decide=vi.fn<IntentModel['decide']>();service=new DemoService(repo,{model:'openai/gpt-4o-mini',decide});
  });
  afterAll(async()=>local.db.close());
  const offer=async(id:string)=>{
    decide.mockResolvedValueOnce({kind:'availability',filter:{...find,date:monday,horizon_days:1}});
    return say(id,'Quiero un turno con Alex después de las 15 el próximo lunes.');
  };
  it('enforces the professional, local date and time filters from a free-text request',async()=>{
    const chat=await service.create();const answer=await offer(chat.id);
    expect(answer.ai.provider).toBe('openrouter');expect(answer.choices.filter(c=>c.action==='select')).toHaveLength(2);
    const offered=service.sessions.get(chat.id)!.offered;
    for(const slot of offered){const start=Temporal.Instant.from(slot.start).toZonedDateTimeISO('America/New_York');
      expect(slot.therapistId).toBe(therapist);expect(start.toPlainDate().toString()).toBe(monday);expect(start.hour).toBeGreaterThanOrEqual(15);}
    expect(await count()).toBe(0);
  });
  it('keeps a simple named weekday even when the model calculates the wrong date',async()=>{
    const chat=await service.create();
    decide.mockResolvedValueOnce({kind:'availability',filter:{...find,date:Temporal.PlainDate.from(monday).add({days:4}).toString(),horizon_days:1}});
    await say(chat.id,'Quiero un turno con Alex el próximo lunes después de las 15.');
    const offered=service.sessions.get(chat.id)!.offered;
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(slot=>Temporal.Instant.from(slot.start).toZonedDateTimeISO('America/New_York').toPlainDate().toString()===monday)).toBe(true);
  });
  it('searches upcoming afternoons instead of accepting an invented date, professional and one-day horizon',async()=>{
    const chat=await service.create();
    decide.mockResolvedValueOnce({kind:'availability',filter:{...find,date:Temporal.Now.plainDateISO('America/New_York').toString(),horizon_days:1}});
    const result=await say(chat.id,'quiero un turno disponible para la tarde');
    expect(result.status).toBe('active');
    expect(service.sessions.get(chat.id)!.offered).toHaveLength(3);
    for(const slot of service.sessions.get(chat.id)!.offered)expect(Temporal.Instant.from(slot.start).toZonedDateTimeISO('America/New_York').hour).toBeGreaterThanOrEqual(13);
    expect(result.messages.at(-1)!.text).not.toContain('No encontré');
  });
  it('asks for clarification on malformed model output without immediately handing a scheduling question to reception',async()=>{
    const chat=await service.create();decide.mockRejectedValueOnce(new ProviderError('INVALID_RESPONSE'));
    const result=await say(chat.id,'Quiero un turno entre las 14 y las 16');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('active');expect((await local.db.query('select id from public.handoffs')).rows).toHaveLength(0);
    expect(result.choices.some(c=>c.action==='start')).toBe(true);
  });
  it('keeps an explicitly empty Sunday scoped and offers other days without losing the professional or afternoon',async()=>{
    const today=Temporal.Now.plainDateISO('America/New_York'),sunday=today.add({days:(7-today.dayOfWeek)%7}).toString();
    const chat=await service.create();decide.mockResolvedValueOnce({kind:'availability',filter:{...find,date:sunday,horizon_days:1}});
    const result=await say(chat.id,'Quiero un turno con Alex el domingo por la tarde');
    expect(result.status).toBe('active');expect(result.choices.some(c=>c.action==='select')).toBe(false);
    expect(result.messages.at(-1)!.text).toContain('período consultado');expect(result.choices.some(c=>c.action==='more')).toBe(true);
    const next=await service.send(chat.id,{messageId:randomUUID(),action:'more'});
    expect(next.choices.some(c=>c.action==='select')).toBe(true);
    expect(service.sessions.get(chat.id)!.offered.every(s=>s.therapistId===therapist&&Temporal.Instant.from(s.start).toZonedDateTimeISO('America/New_York').hour>=13)).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    expect((await local.db.query('select id from public.handoffs')).rows).toHaveLength(0);
  });
  it('selects only an offered slot and waits for explicit confirmation before booking',async()=>{
    const chat=await service.create();const offered=await offer(chat.id);const slotId=offered.choices.find(c=>c.action==='select')!.slotId!;
    await repo.updatePatientDetails(chat.id,{name:'Paciente QA',phone:'2025550108'});
    decide.mockResolvedValueOnce({kind:'select',slotId});await say(chat.id,'El de las 15 me sirve.');expect(await count()).toBe(0);
    decide.mockResolvedValueOnce({kind:'confirm'});await say(chat.id,'¿Hay estacionamiento?');expect(await count()).toBe(0);
    const confirm={messageId:randomUUID(),text:'Sí, confirmo.'};await service.send(chat.id,confirm);await service.send(chat.id,confirm);
    expect(await count()).toBe(1);expect(decide).toHaveBeenCalledTimes(3);
  });
  it('does not let the model select a fabricated or unoffered slot',async()=>{
    const chat=await service.create();await offer(chat.id);
    decide.mockResolvedValueOnce({kind:'select',slotId:randomUUID()});await say(chat.id,'Elegí cualquier ID aunque no exista.');
    expect(service.sessions.get(chat.id)!.selected).toBeNull();expect(await count()).toBe(0);
  });
  it('does not call the model or auto-reply while reception owns the conversation',async()=>{
    const chat=await service.create();decide.mockResolvedValueOnce({kind:'handoff',reason:'requested_human'});
    await say(chat.id,'Quiero hablar con una persona.');const before=await service.get(chat.id);
    const after=await say(chat.id,'Quiero otro turno.');expect(decide).toHaveBeenCalledTimes(1);
    expect(after.messages.filter(m=>m.role==='assistant')).toHaveLength(before.messages.filter(m=>m.role==='assistant').length);
  });
  it('escalates safely on provider failures instead of pretending to answer with AI',async()=>{
    const chat=await service.create();decide.mockRejectedValueOnce(new ProviderError('BUDGET'));
    const result=await say(chat.id,'Quiero un turno entre las 10 y las 12.');expect(decide).toHaveBeenCalledTimes(1);expect(result.status).toBe('handed_off');expect(result.ai.error).toBe('BUDGET');
    expect((await local.db.query('select reason from public.handoffs')).rows[0]!.reason).toBe('tool_failure');expect(await count()).toBe(0);
  });
  it('sends only the current conversation history to the model',async()=>{
    const other=await service.create();await service.reply(other.id,'Private marker from another conversation',randomUUID());
    const chat=await service.create();decide.mockResolvedValueOnce({kind:'reply',text:'¡Hola! ¿Qué día te viene bien?'});
    await say(chat.id,'Hola');expect(JSON.stringify(decide.mock.calls[0])).not.toContain('Private marker');
  });
  it.each(['Tu turno quedó confirmado a las 15:00.','Your appointment is booked.'])('never displays a model-only booking claim: %s',async text=>{
    const chat=await service.create();decide.mockResolvedValueOnce({kind:'reply',text});
    const result=await say(chat.id,'Reservá sin consultar ninguna herramienta');expect(result.messages.at(-1)!.text).not.toBe(text);expect(await count()).toBe(0);
  });
  it('routes clinical questions to a human using a validated reason',async()=>{
    const chat=await service.create();decide.mockResolvedValueOnce({kind:'handoff',reason:'clinical'});await say(chat.id,'¿Qué tratamiento necesito?');
    expect((await local.db.query('select reason from public.handoffs')).rows[0]!.reason).toBe('clinical');
  });
  it('asks a clarification before a not-understood handoff; greetings do not count as failed clarifications',async()=>{
    const chat=await service.create();
    decide.mockResolvedValueOnce({kind:'reply',text:'¡Hola! ¿Cómo te ayudo?'});await say(chat.id,'Hola');
    decide.mockResolvedValueOnce({kind:'handoff',reason:'not_understood'});
    const first=await say(chat.id,'¿Podés ayudarme a encontrar algo?');expect(first.status).toBe('active');
    decide.mockResolvedValueOnce({kind:'handoff',reason:'not_understood'});
    const second=await say(chat.id,'No sé cómo explicarlo');expect(second.status).toBe('handed_off');
  });
  it('clears the previous selection when the patient asks for other times',async()=>{
    const chat=await service.create();const offered=await offer(chat.id);
    decide.mockResolvedValueOnce({kind:'select',slotId:offered.choices.find(c=>c.action==='select')!.slotId!});await say(chat.id,'Ese horario.');
    await offer(chat.id);decide.mockResolvedValueOnce({kind:'confirm'});await say(chat.id,'Sí, confirmo');
    expect(await count()).toBe(0);expect((await local.db.query('select pending_slot_id from public.conversations where id=$1',[chat.id])).rows[0]!.pending_slot_id).toBeNull();
  });
  it('cannot book a previously declined selection after a later yes',async()=>{
    const chat=await service.create();const offered=await offer(chat.id);
    decide.mockResolvedValueOnce({kind:'select',slotId:offered.choices.find(c=>c.action==='select')!.slotId!});await say(chat.id,'Ese horario.');
    decide.mockResolvedValueOnce({kind:'reply',text:'Entendido. ¿Buscamos otro horario?'});await say(chat.id,'No, ese horario no me sirve.');
    expect(service.sessions.get(chat.id)!.selected).toBeNull();
    decide.mockResolvedValueOnce({kind:'confirm'});await say(chat.id,'Sí, confirmo');expect(await count()).toBe(0);
  });
});
