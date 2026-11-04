import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ClinicRepository, DomainError } from '../../../packages/db/src/repository.js';
import { withSavepoints } from '../../../packages/db/src/savepoints.js';
import { isExplicitConfirmation, ProviderError, type AvailabilityInput, type IntentModel, type OfferedSlot } from '../../../packages/agent/src/openrouter.js';
import { normalizeAvailabilitySearch, requestedLocalTime, offeredSelection, rejectsSelectedSlot,isCancellationRequest,isCancellationConfirmation,isRescheduleRequest } from '../../../packages/agent/src/search.js';
import { requestedLocalDate } from '../../../packages/agent/src/calendar.js';
import { renderNarration, type NarrationContext } from '../../../packages/agent/src/narration.js';
import { groundedPatientPatch, missingContact, explicitPatientInfo,type PatientDetails } from '../../../packages/core/src/patient.js';
import { isWeeklyConfirmation,type WeeklyInput } from '../../../packages/agent/src/weekly.js';
import { proposeWeekly,bookWeekly,type WeeklyState } from './weekly-booking.js';

export interface DemoMessage { id: string; role: 'patient' | 'assistant' | 'staff'; text: string; at: string }
export type ChatAction='start'|'more'|'select'|'confirm'|'human'|'reschedule'|'cancel'|'confirm_cancel'|'keep'|'confirm_week'|'discard_week';
export interface DemoChoice { label: string; action: ChatAction; slotId?: string;appointmentId?:string }
interface UpcomingAppointment {id:string;therapistId:string;therapistName:string;start:string;end:string;version:number}
export interface ChatView {id:string;status:string;name:string;messages:DemoMessage[];choices:DemoChoice[];patient:PatientDetails;hasAppointment:boolean;appointments:UpcomingAppointment[];ai:{provider:string;model:string|null;error:string|null}}
interface Session { messages: DemoMessage[]; choices: DemoChoice[]; selected: string | null; processed: Set<string>; offered:OfferedSlot[]; modelRequests:number;modelWindowStart:number; clarificationCount:number; providerError:string|null;search:AvailabilityInput|null;rescheduling:{id:string;version:number}|null;cancellation:{id:string;version:number;expiresAt:number}|null;weekly:WeeklyState|null }
type StoredSession = Omit<Session,'messages'|'selected'|'processed'> & {processed:string[]; inputs:[string,string][]};
export interface ChatInput { messageId: string; text?: string | undefined; action?: ChatAction|undefined; slotId?: string | undefined;appointmentId?:string|undefined }

export class DemoService {
  readonly sessions = new Map<string, Session>();
  // Serialize actions within a conversation while PostgreSQL protects bookings across conversations.
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly inputs = new Map<string,string>();
  constructor(readonly repository: ClinicRepository, private readonly intentModel?:IntentModel, private readonly scoped=false) {}

  private async loadSession(id:string,pending:string|null) {
    const row=(await this.repository.db.query<{state:StoredSession|null;created_at:Date|string}>(`select r.state,c.created_at from public.conversations c
      left join private.conversation_runtime r on r.conversation_id=c.id where c.id=$1`,[id])).rows[0];
    const stored=row?.state;
    const windowStart=stored?.modelWindowStart??new Date(row?.created_at??Date.now()).getTime();
    const expired=Date.now()-windowStart>=3_600_000;
    const messages=(await this.repository.db.query<{id:string;role:DemoMessage['role'];body:string;created_at:Date|string}>(
      'select id,role,body,created_at from public.messages where conversation_id=$1 and body is not null order by sequence',[id])).rows.map(row=>({id:row.id,role:row.role,text:row.body,at:new Date(row.created_at).toISOString()}));
    const session:Session={messages,choices:stored?.choices??[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}],
      selected:pending,processed:new Set(stored?.processed??[]),offered:stored?.offered??[],modelRequests:expired?0:stored?.modelRequests??0,modelWindowStart:expired?Date.now():windowStart,
      clarificationCount:stored?.clarificationCount??0,providerError:expired&&stored?.providerError==='RATE_LIMIT'?null:stored?.providerError??null,search:stored?.search??null,rescheduling:stored?.rescheduling??null,cancellation:stored?.cancellation??null,weekly:stored?.weekly??null};
    for(const [key,value] of stored?.inputs??[])this.inputs.set(key,value);
    this.sessions.set(id,session);
    return session;
  }

  private async saveSession(id:string,session:Session) {
    // Insert only new messages. Sequence preserves order even when timestamps are identical.
    const known=new Set((await this.repository.db.query<{id:string}>('select id from public.messages where conversation_id=$1',[id])).rows.map(row=>row.id));
    const fresh=session.messages.filter(message=>!known.has(message.id));
    if(fresh.length)await this.repository.db.query(`insert into public.messages(id,conversation_id,external_message_id,direction,role,body,created_at)
      select (item->>'id')::uuid,$1,item->>'id',case when item->>'role'='patient' then 'inbound' else 'outbound' end,
        item->>'role',item->>'text',(item->>'at')::timestamptz
      from jsonb_array_elements($2::jsonb) with ordinality as entries(item,position) order by position`,[id,JSON.stringify(fresh)]);
    const {messages,selected,processed,...state}=session;
    await this.repository.db.query(`insert into private.conversation_runtime(conversation_id,state) values ($1,$2::jsonb)
      on conflict(conversation_id) do update set state=excluded.state,updated_at=now()`,[id,JSON.stringify({...state,processed:[...processed],inputs:[...this.inputs]})]);
  }

  private async stored<T>(id:string,operation:(service:DemoService)=>Promise<T>,input?:{key:string;payload:unknown}) {
    return this.serial(id,async()=>{
      let snapshot:Session|undefined;
      const result=await this.repository.db.transaction(async db=>{
        // The same verified patient may resume through another conversation.
        const patient=await this.repository.getConversationPatientId(id,db);
        await db.query('select id from public.patients where id=$1 for update',[patient]);
        // A database lock serializes retries and staff/patient actions across server instances.
        const row=(await db.query<{pending:string|null}>(`select case when pending_expires_at>now() and status='active' then pending_slot_id end as pending
          from public.conversations where id=$1 for update`,[id])).rows[0];
        if(!row)throw new DomainError('CONVERSATION_NOT_FOUND',404);
        const service=new DemoService(new ClinicRepository(withSavepoints(db)),this.intentModel,true);
        snapshot=await service.loadSession(id,row.pending);
        if(input){
          const payload=createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),previous=service.inputs.get(input.key);
          if(previous&&previous!==payload)throw new DomainError('IDEMPOTENCY_CONFLICT',409);
          service.inputs.set(input.key,payload);
        }
        const value=await operation(service);
        await service.saveSession(id,snapshot);
        return value;
      });
      // This map is a compatibility snapshot, never the source of truth after a restart.
      if(snapshot)this.sessions.set(id,snapshot);
      return result;
    });
  }

  private add(session: Session, role: DemoMessage['role'], text: string) {
    session.messages.push({ id: randomUUID(), role, text, at: new Date().toISOString() });
  }
  private async narrate(session:Session,index:number,context:NarrationContext,verifiedSuffix='') {
    const message=session.messages[index];
    if(!this.intentModel?.explain||session.modelRequests>=20||message?.role!=='assistant')return;
    session.modelRequests++;
    try{
      const draft=await this.intentModel.explain(context);
      const explanation=renderNarration(draft,context);
      if(explanation)message.text=explanation+(verifiedSuffix?`\n\n${verifiedSuffix}`:'');
    }catch{
      // Narration is cosmetic: retain the successful operation, choices and fallback text.
      // Never retry a booking or escalate a patient because the writer was unavailable.
    }
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(id, current);
    try { return await current; } finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }

  async create(name = 'Paciente de prueba',externalIdentity?:string) {
    const patient = randomUUID(), identity = randomUUID(), conversation = randomUUID();
    await this.repository.db.transaction(async db => {
      await db.query('insert into public.patients(id,name,name_collected) values ($1,$2,$3)', [patient, name,name!=='Paciente de prueba']);
      await db.query("insert into public.patient_identities(id,patient_id,channel,external_user_id) values ($1,$2,'telegram',$3)", [identity, patient, externalIdentity??`demo-${identity}`]);
      await db.query('insert into public.conversations(id,identity_id) values ($1,$2)', [conversation,identity]);
      const service=new DemoService(new ClinicRepository(withSavepoints(db)),this.intentModel,true);
      const session=await service.loadSession(conversation,null);
      session.choices=[{ label: 'Quiero reservar un turno', action: 'start' }, { label: 'Hablar con recepción', action: 'human' }];
      service.add(session,'assistant','¡Hola! Soy el asistente de Clínica Demo. Te ayudo a encontrar un turno. ¿Qué te gustaría hacer?');
      await service.saveSession(conversation,session);
    });
    return this.get(conversation);
  }

  async continueArchived(id:string){
    const next=await this.repository.db.transaction(async db=>{
      const patient=await this.repository.getConversationPatientId(id,db);await db.query('select id from public.patients where id=$1 for update',[patient]);
      const old=(await db.query('select identity_id,archived_at from public.conversations where id=$1 for update',[id])).rows[0]!;
      if(!old.archived_at)throw new DomainError('CONVERSATION_NOT_ARCHIVED',409);
      const conversation=randomUUID();await db.query('insert into public.conversations(id,identity_id) values ($1,$2)',[conversation,old.identity_id]);
      const service=new DemoService(new ClinicRepository(withSavepoints(db)),this.intentModel,true),session=await service.loadSession(conversation,null);
      service.add(session,'assistant','Retomamos la consulta con tu ficha y tus reservas guardadas. ¿Querés reservar, cambiar o cancelar un turno?');
      session.choices=[{label:'Buscar horarios',action:'start'},{label:'Cambiar un turno',action:'reschedule'},{label:'Cancelar un turno',action:'cancel'},{label:'Hablar con recepción',action:'human'}];
      await service.saveSession(conversation,session);return conversation;
    });
    return this.get(next);
  }

  async get(id: string):Promise<ChatView> {
    if(!this.scoped)return this.stored(id,service=>service.get(id));
    const row = (await this.repository.db.query(`select c.id,c.status,p.name,
      case when c.pending_expires_at>now() then c.pending_slot_id end as pending_slot_id,
      exists(select 1 from public.appointments a where a.patient_id=p.id and a.status='confirmed') as has_appointment from public.conversations c
      join public.patient_identities i on i.id=c.identity_id join public.patients p on p.id=i.patient_id where c.id=$1 and c.archived_at is null`, [id])).rows[0];
    if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 404);
    let session = this.sessions.get(id);
    if(!session){
      session=await this.loadSession(id,row.pending_slot_id?String(row.pending_slot_id):null);
    }
    if(row.status!=='active')session.weekly=null;
    const appointments=(await this.repository.getUpcomingAppointments(id)).map(a=>({id:a.id,therapistId:a.therapist_id,therapistName:a.therapist_name,start:new Date(a.starts_at).toISOString(),end:new Date(a.ends_at).toISOString(),version:a.version}));
    if(session.cancellation&&(session.cancellation.expiresAt<=Date.now()||!appointments.some(a=>a.id===session.cancellation!.id&&a.version===session.cancellation!.version))){
      session.cancellation=null;session.choices=[{label:'Revisar mis turnos para cancelar',action:'cancel'},{label:'Hablar con recepción',action:'human'}];
    }
    if(session.rescheduling&&!appointments.some(a=>a.id===session.rescheduling!.id&&a.version===session.rescheduling!.version)){
      session.rescheduling=null;session.selected=null;session.offered=[];session.choices=[{label:'Buscar horarios',action:'start'}];row.pending_slot_id=null;
      await this.repository.db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[id]);
    }
    session.selected=row.status==='active'&&row.pending_slot_id?String(row.pending_slot_id):null;
    if(!session.selected)session.choices=session.choices.filter(choice=>choice.action!=='confirm');
    const patient=await this.repository.getPatientDetails(id);
    if(session.selected&&!missingContact(patient).length&&!session.choices.some(c=>c.action==='confirm'))session.choices.unshift({label:'Confirmar turno',action:'confirm'});
    return { id:String(row.id),status:String(row.status),name:String(row.name),messages: session?.messages ?? [], choices: row.status === 'active' ? session?.choices ?? [] : [],
      patient,hasAppointment:Boolean(row.has_appointment),appointments,
      ai:{provider:this.intentModel?'openrouter':'guided',model:this.intentModel?.model??null,error:session?.providerError??null} };
  }

  private async prepareReschedule(id:string,session:Session,current:ChatView,appointmentId:string|null,filter:AvailabilityInput|null) {
    session.weekly=null;
    session.cancellation=null;
    const target=appointmentId?current.appointments.find(a=>a.id===appointmentId):current.appointments.length===1?current.appointments[0]:null;
    session.selected=null;session.offered=[];
    await this.repository.db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[id]);
    if(!target){
      session.rescheduling=null;session.search=filter;
      this.add(session,'assistant',current.appointments.length?'¿Cuál de tus turnos querés cambiar? El turno actual se mantiene hasta que confirmes otro horario.':'No encuentro una reserva futura vinculada a tu ficha. Si se creó manualmente con otra ficha, recepción puede vincularla sin volver a reservar.');
      const zone=(await this.repository.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!.time_zone;
      session.choices=current.appointments.map(a=>({action:'reschedule',appointmentId:a.id,label:`Cambiar ${new Intl.DateTimeFormat('es-AR',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(a.start))} · ${a.therapistName}`}));
      session.choices.push({label:'Hablar con recepción',action:'human'});return false;
    }
    session.rescheduling={id:target.id,version:target.version};session.search=filter;
    return true;
  }

  private async prepareCancellation(id:string,session:Session,current:ChatView,appointmentId:string|null,text:string){
    session.weekly=null;
    session.cancellation=null;session.rescheduling=null;session.selected=null;session.offered=[];session.providerError=null;
    await this.repository.db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[id]);
    const zone=(await this.repository.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!.time_zone;
    const when=(a:UpcomingAppointment)=>new Intl.DateTimeFormat('es-AR',{timeZone:zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(a.start));
    let candidates=current.appointments;
    if(appointmentId)candidates=candidates.filter(a=>a.id===appointmentId);
    else{
      let day:string|null=null;try{day=requestedLocalDate(text,Temporal.Now.instant().toString(),zone);}catch{/* Ask the patient to choose rather than guess an invalid date. */}
      const time=requestedLocalTime(text);
      if(day||time)candidates=candidates.filter(a=>{const start=Temporal.Instant.from(a.start).toZonedDateTimeISO(zone);return (!day||start.toPlainDate().toString()===day)&&(!time||`${String(start.hour).padStart(2,'0')}:${String(start.minute).padStart(2,'0')}`===time);});
    }
    const target=candidates.length===1?candidates[0]:null;
    if(!target){
      this.add(session,'assistant',!current.appointments.length?'No encuentro turnos futuros confirmados vinculados a tu ficha.':candidates.length?'¿Cuál de tus turnos querés cancelar?':'No encuentro un turno que coincida con esa fecha u horario. Elegí cuál querés cancelar:');
      session.choices=(candidates.length?candidates:current.appointments).map(a=>({label:`Cancelar ${when(a)} · ${a.therapistName}`,action:'cancel',appointmentId:a.id}));
      session.choices.push({label:'Mantener mis turnos',action:'keep'});return;
    }
    session.cancellation={id:target.id,version:target.version,expiresAt:Date.now()+600_000};
    this.add(session,'assistant',`Tu turno es el ${when(target)} con ${target.therapistName}. ¿Confirmás que querés cancelarlo?`);
    session.choices=[{label:'Sí, cancelar este turno',action:'confirm_cancel'},{label:'Cambiar de horario',action:'reschedule',appointmentId:target.id},{label:'Mantener el turno',action:'keep'}];
  }

  private async prepareWeekly(id:string,session:Session,current:ChatView,request:WeeklyInput,text:string){
    const previous=session.weekly?.request;
    session.cancellation=null;session.rescheduling=null;session.selected=null;session.offered=[];session.search=null;
    await this.repository.db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[id]);
    try{
      const result=await proposeWeekly(this.repository,current,request,text,previous);
      session.weekly=result.state;this.add(session,'assistant',result.message);
      if(result.state.plan&&!result.state.plan.slots.length)session.weekly=null;
      session.choices=[...(session.weekly?.ready?[{label:'Confirmar los turnos de la semana',action:'confirm_week'} as DemoChoice]:[]),
        ...(session.weekly?[{label:'Descartar esta propuesta',action:'discard_week'} as DemoChoice]:[{label:'Buscar horarios',action:'start'} as DemoChoice]),{label:'Hablar con recepción',action:'human'}];
    }catch(error){
      if(!(error instanceof RangeError))throw error;
      session.weekly={request,plan:null,ready:false};
      this.add(session,'assistant','No pude resolver esa fecha u hora de forma inequívoca. ¿Qué semana y horario querés reservar?');
      session.choices=[{label:'Descartar esta propuesta',action:'discard_week'},{label:'Hablar con recepción',action:'human'}];
    }
  }

  private async confirmWeekly(id:string,session:Session,current:ChatView,messageId:string){
    const pending=session.weekly;
    if(!pending){this.add(session,'assistant','Primero necesito revisar los días y mostrarte la propuesta semanal para que la confirmes.');session.choices=[{label:'Buscar horarios',action:'start'}];return;}
    if(!pending.plan||!pending.ready||pending.plan.expiresAt<=Date.now()){
      if(pending.plan?.expiresAt&&pending.plan.expiresAt<=Date.now())this.add(session,'assistant','La propuesta venció. Voy a revisar los horarios otra vez antes de pedirte una confirmación nueva.');
      await this.prepareWeekly(id,session,current,pending.request,'');return;
    }
    try{
      const results=await bookWeekly(this.repository,id,pending.plan,`week-${messageId}`);
      const zone=(await this.repository.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!.time_zone;
      const lines=pending.plan.slots.map(slot=>`• ${new Intl.DateTimeFormat('es-AR',{timeZone:zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(slot.start))} · ${slot.therapistName}`);
      this.add(session,'assistant',`Quedaron confirmados los ${results.length} turnos nuevos:\n${lines.join('\n')}${pending.plan.existing.length?'\nLos turnos que ya tenías confirmados se conservaron.':''}`);
      session.weekly=null;session.choices=[{label:'Hablar con recepción',action:'human'}];
    }catch(error){
      if(!(error instanceof DomainError))throw error;
      this.add(session,'assistant',error.code==='AGENT_PAUSED'?'Recepción está atendiendo esta conversación. No agregué turnos.':'La propuesta cambió y no agregué ningún turno nuevo. Voy a revisar toda la semana otra vez; tus reservas previas se conservan.');
      if(error.code!=='AGENT_PAUSED')await this.prepareWeekly(id,session,await this.get(id),pending.request,'');
    }
  }

  async send(id: string, input: ChatInput):Promise<ChatView> {
    if(!this.scoped)return this.stored(id,service=>service.send(id,input),{key:input.messageId,payload:{kind:'patient',text:input.text??null,action:input.action??null,slotId:input.slotId??null,...(input.appointmentId?{appointmentId:input.appointmentId}:{})}});
    return this.serial(id, async () => {
      const current = await this.get(id);
      const session = this.sessions.get(id);
      if (!session) throw new DomainError('DEMO_SESSION_NOT_FOUND', 404);
      if (session.processed.has(input.messageId)) return this.get(id);
      if (session.messages.length > 120) throw new DomainError('DEMO_LIMIT_REACHED', 409);
      let action = input.action ?? (/recepci[oó]n|humano|persona|ayuda|factura|dolor|m[eé]dic/i.test(input.text ?? '') ? 'human' : 'start');
      const text = input.text ?? ({ start: 'Quiero reservar un turno',more:'Buscar en los próximos días', select: 'Ese horario me sirve', confirm: 'Sí, confirmo el turno', human: 'Quiero hablar con recepción',reschedule:'Quiero cambiar ese turno',cancel:'Quiero cancelar ese turno',confirm_cancel:'Sí, confirmo la cancelación',keep:'Mantener mis turnos',confirm_week:'Sí, confirmo los turnos de la semana',discard_week:'Descartar la propuesta semanal' }[action]);
      // Only this conversation's persisted transcript is supplied to the model.
      this.add(session, 'patient', text);
      const pendingCancellation=session.cancellation;
      const weeklyConfirmation=input.action==='confirm_week'||Boolean(session.weekly&&input.text&&(isExplicitConfirmation(input.text)||isWeeklyConfirmation(input.text)));
      if(session.weekly&&!weeklyConfirmation)session.weekly.ready=false;
      if(input.text&&!isCancellationConfirmation(input.text)){session.cancellation=null;session.choices=session.choices.filter(c=>c.action!=='confirm_cancel');}
      const explicitInfo=input.text?explicitPatientInfo(input.text):null;
      if(explicitInfo){
        await this.repository.updatePatientDetails(id,explicitInfo);
        if(current.status==='active')this.add(session,'assistant',explicitInfo.reported_reason?'Guardé lo que me contaste como motivo referido por vos, sin verificación clínica.':'Guardé esa información en tu ficha.');
        if(current.status==='active'&&session.weekly&&!isCancellationRequest(input.text??'')){await this.prepareWeekly(id,session,current,session.weekly.request,'');session.processed.add(input.messageId);return this.get(id);}
        if(current.status!=='active'||!isCancellationRequest(input.text??'')){session.processed.add(input.messageId);return this.get(id);}
      }
      if (current.status !== 'active') {
        session.processed.add(input.messageId);
        return this.get(id);
      }
      if(weeklyConfirmation){await this.confirmWeekly(id,session,current,input.messageId);session.processed.add(input.messageId);return this.get(id);}
      if(input.action==='discard_week'||session.weekly&&input.text&&/^(?:no(?: gracias)?|mejor no|descartar|no confirmo)[.!]?$/i.test(input.text.trim())){
        session.weekly=null;session.choices=[{label:'Buscar horarios',action:'start'}];this.add(session,'assistant','Descarté la propuesta semanal. No agregué turnos; tus reservas anteriores se conservan.');session.processed.add(input.messageId);return this.get(id);
      }
      const keep=input.action==='keep'||pendingCancellation&&input.text&&/^(?:no(?: gracias)?[.!]?$|no[, ]+(?:lo |la )?canceles|no quiero cancelar|mejor no\b|manten|dejalo)/i.test(input.text.trim());
      if(keep){
        session.cancellation=null;session.choices=[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];
        this.add(session,'assistant','Tus reservas se mantienen. No cancelé ningún turno.');session.processed.add(input.messageId);return this.get(id);
      }
      if(input.action==='confirm_cancel'||pendingCancellation&&input.text&&isCancellationConfirmation(input.text)){
        const pending=session.cancellation;
        if(!pending||pending.expiresAt<=Date.now())this.add(session,'assistant','La confirmación de cancelación venció o el turno cambió. Elegí nuevamente el turno que querés cancelar.');
        else{
          try{await this.repository.cancelPatientAppointment(pending.id,id,pending.version);this.add(session,'assistant','Tu turno quedó cancelado y ese horario volvió a estar disponible.');}
          catch(error){if(!(error instanceof DomainError))throw error;this.add(session,'assistant',error.code==='DELIVERY_IN_PROGRESS'?'Hay una operación en curso y no pude completar la cancelación. Intentá nuevamente en unos momentos.':'El turno cambió o ya no permite esa cancelación. No cancelé otra reserva.');}
        }
        session.cancellation=null;session.choices=[{label:'Buscar horarios',action:'start'},{label:'Elegir otro turno para cancelar',action:'cancel'},{label:'Hablar con recepción',action:'human'}];
        session.processed.add(input.messageId);return this.get(id);
      }
      const cancellationChoices=session.choices.filter(c=>c.action==='cancel'&&c.appointmentId);
      const ordinalCancellation=input.text?offeredSelection(input.text,cancellationChoices.map(c=>({id:c.appointmentId!}))):null;
      if(input.action==='cancel'||!input.action&&input.text&&(isCancellationRequest(input.text)||ordinalCancellation||cancellationChoices.length&&!isRescheduleRequest(input.text)&&!/(recepci[oó]n|humano|persona)/i.test(input.text))){
        await this.prepareCancellation(id,session,current,input.appointmentId??ordinalCancellation??null,input.text??'');
        session.processed.add(input.messageId);return this.get(id);
      }
      // A rejected selection must not survive a later ambiguous "sí".
      if(session.selected&&input.text&&rejectsSelectedSlot(input.text)){
        session.selected=null;
        await this.repository.db.query("update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1 and status='active'",[id]);
        session.choices=[{label:'Buscar otros horarios',action:'start'}];
      }
      let filter:AvailabilityInput|null=input.action==='more'&&session.search?{...session.search,date:null,horizon_days:14}:null;
      if(session.rescheduling&&input.text&&/\b(no quiero (?:cambiar|reprogramar)|dej[aá].*(?:como estaba|como est[aá])|manten[eé].*turno)\b/i.test(input.text)){
        session.rescheduling=null;session.selected=null;session.offered=[];session.choices=[{label:'Hablar con recepción',action:'human'}];
        await this.repository.db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[id]);
        this.add(session,'assistant','Tu turno actual se mantiene. No hice ningún cambio.');session.processed.add(input.messageId);return this.get(id);
      }
      if(input.action==='reschedule'){
        filter=session.search;
        if(!await this.prepareReschedule(id,session,current,input.appointmentId??null,filter)){session.processed.add(input.messageId);return this.get(id);}
        action='start';
      }
      let selectedSlot=input.slotId;
      let reason='requested_human';
      const ordinal=input.text&&!input.action?offeredSelection(input.text,session.offered):null;
      if(ordinal){action='select';selectedSlot=ordinal;}
      if(this.intentModel&&input.text&&!input.action&&!ordinal){
        if(session.selected&&isExplicitConfirmation(input.text))action='confirm';
        else {
          try{
            if(session.modelRequests>=20)throw new ProviderError('RATE_LIMIT');
            session.modelRequests++;
            const clinic=(await this.repository.db.query<{name:string;time_zone:string}>('select name,time_zone from public.clinics')).rows[0]!;
            const therapists=(await this.repository.getTherapists()).map(t=>({id:String(t.id),name:String(t.name),specialty:String(t.specialty)}));
            const localNow=Temporal.Now.zonedDateTimeISO(clinic.time_zone).toString();
            const decision=await this.intentModel.decide({now:localNow,timeZone:clinic.time_zone,clinicName:clinic.name,therapists,
              patient:{name:current.patient.name_collected?current.patient.name:null,phone:current.patient.phone,insurance:current.patient.insurance,summary:current.patient.intake_summary,missing:missingContact(current.patient)},hasAppointment:current.hasAppointment,appointments:current.appointments,rescheduling:session.rescheduling,search:session.search,weeklyRequest:session.weekly?.request??null,
              offered:session.offered,selectedSlotId:session.selected,history:session.messages.map(m=>({role:m.role,text:m.text}))});
            session.providerError=null;
            if((await this.get(id)).status!=='active'){session.processed.add(input.messageId);return this.get(id);}
            if(decision.kind==='weekly'){
              await this.prepareWeekly(id,session,current,decision.request,input.text);session.processed.add(input.messageId);return this.get(id);
            }
            if(decision.kind==='cancel'){
              await this.prepareCancellation(id,session,current,decision.appointmentId,input.text);session.processed.add(input.messageId);return this.get(id);
            }
            if(decision.kind==='patient'){
              if(session.weekly){
                const request=session.weekly.request;
                try{
                  const patient=await this.repository.updatePatientDetails(id,groundedPatientPatch(decision.details,input.text)),missing=missingContact(patient);
                  if(missing.length){this.add(session,'assistant',`Gracias. Para reservar los turnos de la semana me falta tu ${missing[0]}.`);session.processed.add(input.messageId);return this.get(id);}
                }
                catch{this.add(session,'assistant','No pude guardar esos datos. Indicame un nombre y teléfono válido de 7 a 15 dígitos.');session.processed.add(input.messageId);return this.get(id);}
                await this.prepareWeekly(id,session,current,request,'');session.processed.add(input.messageId);return this.get(id);
              }
              let intake:NarrationContext|null=null;
              let suffix='';
              const replyIndex=session.messages.length;
              try{
                const patch=groundedPatientPatch(decision.details,input.text);
                const patient=await this.repository.updatePatientDetails(id,patch);
                const missing=missingContact(patient);
                suffix=missing.length?`Para reservar me falta tu ${missing.join(' y ')}.`:'';
                intake={event:'patient_updated',request:text,facts:{saved_fields:Object.keys(patch),missing_contact:missing},variables:{}};
                this.add(session,'assistant',`Guardé tu ficha.${missing.length?` Para reservar me falta tu ${missing.join(' y ')}.`:' Podés corregir tus datos cuando quieras.'}`);
                if(session.selected&&!missing.length){
                  try{
                    const selection=await this.repository.selectSlot(id,session.selected);
                    const when=new Intl.DateTimeFormat('es-AR',{timeZone:clinic.time_zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(String(selection.starts_at)));
                    this.add(session,'assistant',`El turno sería con ${selection.therapist} el ${when}, a nombre de ${patient.name}, teléfono ${patient.phone}. ¿Lo confirmás?`);
                  }catch(error){if(!(error instanceof DomainError))throw error;session.selected=null;this.add(session,'assistant','Tus datos están guardados. Necesitamos elegir un horario disponible otra vez.');}
                }
                session.choices=session.selected&&!missing.length?[{label:'Confirmar turno',action:'confirm'},{label:'Ver otros horarios',action:'start'}]:session.selected?[]:[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];
              }catch{
                intake=null;
                this.add(session,'assistant','No pude guardar esos datos. Indicame tu nombre y un teléfono válido de 7 a 15 dígitos; no agrego prefijos automáticamente.');
              }
              if(intake)await this.narrate(session,replyIndex,intake,suffix);
              session.processed.add(input.messageId);return this.get(id);
            }
            if(decision.kind==='reply'){
              // Only successful backend operations may announce concrete appointments or times.
              const unsafeClaim=/\b(reservad[oa]s?|confirmad[oa]s?|agendad[oa]s?|cancelad[oa]s?|cancel[eé]|cancelled|canceled|reprogramad[oa]s?|reprogram[eé]|cambi[eé]|cambiad[oa]s?|mov[ií]|booked|confirmed|scheduled|rescheduled|guard[eé]|guardad[oa]s?|actualic[eé]|actualizad[oa]s?|registr[eé])\b|te agend[eé]|\b\d{1,2}:\d{2}\b/i.test(decision.text);
              this.add(session,'assistant',unsafeClaim?'Para reservar, primero elegí un horario de la agenda y confirmalo.':decision.text);
              session.clarificationCount=unsafeClaim?session.clarificationCount+1:0;
              if(session.clarificationCount>=2&&unsafeClaim){await this.repository.escalate(id,'not_understood');this.add(session,'assistant','Voy a pasarle tu consulta a recepción para que te ayuden.');}
              session.processed.add(input.messageId);return this.get(id);
            }
            if(decision.kind!=='handoff'||decision.reason!=='not_understood')session.clarificationCount=0;
            if(decision.kind==='availability'||decision.kind==='reschedule'){
              session.weekly=null;
              action='start';filter=normalizeAvailabilitySearch(decision.filter,input.text,localNow,clinic.time_zone,therapists,session.search);
              if(decision.kind==='reschedule'&&!await this.prepareReschedule(id,session,current,decision.appointmentId,filter)){session.processed.add(input.messageId);return this.get(id);}
            }
            if(decision.kind==='select'){action='select';selectedSlot=decision.slotId;}
            if(decision.kind==='handoff'){
              if(decision.reason==='not_understood'&&++session.clarificationCount<2){
                this.add(session,'assistant','¿Qué día o franja horaria te conviene? Puedo consultar la agenda sin pedirte datos todavía.');
                session.choices=[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];
                session.processed.add(input.messageId);return this.get(id);
              }
              action='human';reason=decision.reason;
            }
            if(decision.kind==='confirm'){
              if(session.weekly){await this.prepareWeekly(id,session,current,session.weekly.request,'');session.processed.add(input.messageId);return this.get(id);}
              // A tool argument never acts as patient consent.
              this.add(session,'assistant',session.selected?'Para confirmar ese turno, tocá «Confirmar turno» o escribí «sí, confirmo».':'Primero tenemos que elegir un horario.');
              session.choices=session.selected?[{label:'Confirmar turno',action:'confirm'},{label:'Ver otros horarios',action:'start'}]:[{label:'Buscar horarios',action:'start'}];
              session.processed.add(input.messageId);return this.get(id);
            }
          }catch(error){
            if(error instanceof ProviderError&&error.code==='RATE_LIMIT'){
              session.providerError='RATE_LIMIT';
              this.add(session,'assistant','Se alcanzó un límite temporal de consultas a la IA. Podés seguir con los botones para buscar horarios, cambiar o cancelar una reserva.');
              session.choices=[{label:'Buscar horarios',action:'start'},...(current.appointments.length?[{label:'Cambiar un turno',action:'reschedule'} as DemoChoice,{label:'Cancelar un turno',action:'cancel'} as DemoChoice]:[]),{label:'Hablar con recepción',action:'human'}];
              session.processed.add(input.messageId);return this.get(id);
            }
            if(error instanceof ProviderError&&error.code==='INVALID_RESPONSE'){
              session.providerError=null;
              this.add(session,'assistant','No pude interpretar bien esa respuesta. ¿Qué día o franja horaria te conviene? También podés consultar los próximos horarios con el botón.');
              session.choices=[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];
              session.processed.add(input.messageId);return this.get(id);
            }
            session.providerError=error instanceof ProviderError?error.code:'UNAVAILABLE';
            await this.repository.escalate(id,'tool_failure');
            this.add(session,'assistant','El asistente de IA no está disponible ahora. Le paso tu conversación a recepción para que puedan ayudarte.');
            session.choices=[];session.processed.add(input.messageId);return this.get(id);
          }
        }
      }else if(!input.action&&session.selected&&isExplicitConfirmation(text))action='confirm';
      session.choices = [];
      session.weekly=null;
      const replyIndex=session.messages.length;
      let narration:NarrationContext|null=null;
      let verifiedSuffix='';
      try {
        if (action === 'human') {
          await this.repository.escalate(id, reason);
          this.add(session, 'assistant', 'Claro. Le paso tu conversación a recepción. El equipo podrá responderte por acá.');
          if(!input.action)narration={event:'handoff',request:text,facts:{reason,handed_off:true},variables:{}};
        } else if (action === 'select') {
          if (!selectedSlot||!session.offered.some(slot=>slot.id===selectedSlot)) throw new DomainError('SLOT_UNAVAILABLE', 409);
          const selection = await this.repository.selectSlot(id, selectedSlot);
          session.selected = selectedSlot;
          const clinic = (await this.repository.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
          const when = new Intl.DateTimeFormat('es-AR', { timeZone: clinic.time_zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',hourCycle:'h23' }).format(new Date(String(selection.starts_at)));
          const missing=missingContact(await this.repository.getPatientDetails(id));
          verifiedSuffix=`${session.rescheduling?'El cambio':'El turno'} sería con ${selection.therapist} el ${when}. ${missing.length?`Antes de confirmar, necesito tu ${missing.join(' y ')}.`:'¿Lo confirmás?'}${session.rescheduling?' Tu reserva actual se mantiene hasta confirmar el cambio.':''}`;
          this.add(session, 'assistant',verifiedSuffix);
          narration={event:'selected',request:text,facts:{booked:false,missing_contact:missing,details_appended_by_backend:true},variables:{}};
          session.choices = [...(!missing.length?[{ label: 'Confirmar turno', action: 'confirm' } as DemoChoice]:[]),{ label: 'Ver otros horarios', action: 'start' }];
        } else if (action === 'confirm') {
          if (!session.selected) throw new DomainError('CONFIRMATION_REQUIRED', 409);
          const missing=missingContact(await this.repository.getPatientDetails(id));
          if(missing.length){this.add(session,'assistant',`Para confirmar el turno necesito tu ${missing.join(' y ')}. El horario todavía no está reservado.`);session.processed.add(input.messageId);return this.get(id);}
          const selected=session.offered.find(slot=>slot.id===session.selected);
          const clinic=(await this.repository.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
          const moving=session.rescheduling;
          const booked = moving?await this.repository.rescheduleAppointment(moving.id,session.selected,`chat-${input.messageId}`,{expectedVersion:moving.version,confirmed:true,conversationId:id}):await this.repository.book(id, session.selected, `demo-${input.messageId}`, true);
          if(booked.status!=='confirmed')throw new Error('Unexpected booking status');
          if(selected){
            const when=new Intl.DateTimeFormat('es-AR',{timeZone:clinic.time_zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(selected.start));
            verifiedSuffix=`${when} · ${selected.therapistName}. En esta demo no enviamos correos.`;
          }else verifiedSuffix='En esta demo no enviamos correos.';
          this.add(session, 'assistant', moving?`Tu turno quedó reprogramado. El horario anterior está libre. ${verifiedSuffix}`:'¡Listo! Tu turno quedó confirmado y ya aparece en la agenda de la clínica. En esta demo no enviamos correos.');
          narration={event:moving?'rescheduled':'booked',request:text,facts:{booking_succeeded:true,notifications_sent:false,details_appended_by_backend:true},variables:{}};
          session.rescheduling=null;
          session.selected = null;
          session.choices = [{ label: 'Hablar con recepción', action: 'human' }];
        } else {
          session.selected=null;
          await this.repository.db.query("update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1 and status='active'",[id]);
          const clinic = (await this.repository.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
          if(session.rescheduling){
            const original=current.appointments.find(a=>a.id===session.rescheduling!.id);
            const therapists=await this.repository.getTherapists();
            const named=input.text&&therapists.some(t=>input.text!.toLowerCase().includes(String(t.name).toLowerCase().split(' ')[0]!));
            if(original&&!filter?.therapist_id&&!named&&!/cualquier|cualquiera|sin preferencia|me da igual/i.test(input.text??''))filter={...(filter??session.search??{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14}),therapist_id:original.therapistId};
          }
          const today=Temporal.Now.plainDateISO(clinic.time_zone);
          const fromDate=filter?.date?Temporal.PlainDate.from(filter.date):today;
          session.search=filter??{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14};
          if(Temporal.PlainDate.compare(fromDate,today)<0||Temporal.PlainDate.compare(fromDate,today.add({days:41}))>0)throw new DomainError('INVALID_DATE_RANGE',400);
          const now=fromDate.toZonedDateTime(clinic.time_zone).toInstant().toString();
          const to=fromDate.add({days:filter?.horizon_days??14}).toZonedDateTime(clinic.time_zone).toInstant().toString();
          const therapists = await this.repository.getTherapists();
          if(filter?.therapist_id&&!therapists.some(t=>t.id===filter?.therapist_id))throw new DomainError('SLOT_UNAVAILABLE',409);
          const candidates: OfferedSlot[] = [];
          let complete=true;
          const minute=(time:string)=>Number(time.split(':')[0])*60+Number(time.split(':')[1]);
          for (const therapist of therapists) {
            if(filter?.therapist_id&&therapist.id!==filter.therapist_id)continue;
            const available = await this.repository.getAvailability(String(therapist.id), now, to);
            if(available.length>=500)complete=false;
            const matching=available.filter(slot=>{
              const start=Temporal.Instant.from(new Date(String(slot.starts_at)).toISOString()).toZonedDateTimeISO(clinic.time_zone);
              const end=Temporal.Instant.from(new Date(String(slot.ends_at)).toISOString()).toZonedDateTimeISO(clinic.time_zone);
              return (!filter?.not_before||start.hour*60+start.minute>=minute(filter.not_before))&&(!filter?.not_after||end.hour*60+end.minute<=minute(filter.not_after));
            });
            for (const slot of matching) candidates.push({id:String(slot.id),therapistId:String(therapist.id),therapistName:String(therapist.name),start:new Date(String(slot.starts_at)).toISOString(),end:new Date(String(slot.ends_at)).toISOString()});
          }
          candidates.sort((a,b) => Date.parse(a.start)-Date.parse(b.start));
          const exactTime=input.text?requestedLocalTime(input.text):null;
          const slotTime=(slot:OfferedSlot)=>{const local=Temporal.Instant.from(slot.start).toZonedDateTimeISO(clinic.time_zone);return `${String(local.hour).padStart(2,'0')}:${String(local.minute).padStart(2,'0')}`;};
          const exact=exactTime?candidates.filter(slot=>slotTime(slot)===exactTime):[];
          const exactStatus=exactTime?(exact.length?'available':complete?'unavailable':'unknown'):'not_requested';
          // Search the full fetched result before deciding the requested time is unavailable.
          // Alternatives stay within the day, period and therapist that were actually queried.
          const ranked=exact.length?exact:exactTime?[...candidates].sort((a,b)=>{
            const distance=(slot:OfferedSlot)=>Math.abs(minute(slotTime(slot))-minute(exactTime));
            return distance(a)-distance(b)||Date.parse(a.start)-Date.parse(b.start);
          }):filter?.time_preference==='latest'?[...candidates].sort((a,b)=>{
            // Keep the nearest local day first, then use its latest real openings.
            const day=(slot:OfferedSlot)=>Temporal.Instant.from(slot.start).toZonedDateTimeISO(clinic.time_zone).toPlainDate().toString();
            return day(a).localeCompare(day(b))||minute(slotTime(b))-minute(slotTime(a));
          }):candidates;
          session.offered=ranked.slice(0,3);
          const limitation=exactStatus==='unavailable'?`A las ${exactTime} no hay turnos disponibles en el período consultado. `:'';
          this.add(session, 'assistant', candidates.length ? `${limitation}${exactTime&&!exact.length?'Te muestro otros horarios disponibles en ese período':filter?.time_preference==='latest'?'Estos son los últimos horarios libres de la jornada en el período que pediste':filter?.time_preference==='earliest'?'Estos son los primeros horarios disponibles':'Estos son los próximos horarios disponibles'}. Elegí el que te quede mejor:` : `${limitation}${complete?'No hay horarios que coincidan en el período consultado.':'No encontré horarios que coincidan en los resultados consultados.'} Podés buscar otros días o cambiar tus preferencias.`);
          const variables:Record<string,string>={};
          if(exactTime)variables.requested_time=exactTime;
          if(filter?.date)variables.day=new Intl.DateTimeFormat('es-AR',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(`${filter.date}T12:00:00Z`));
          const preferred=therapists.find(t=>t.id===filter?.therapist_id);
          if(preferred)variables.therapist=String(preferred.name);
          if(filter?.not_before||filter?.not_after)variables.window=`${filter.not_before??'00:00'}–${filter.not_after??'23:59'}`;
          narration={event:'availability',request:text,facts:{time_zone:clinic.time_zone,search_complete:complete,
            exact_time_status:exactStatus,offered_count:session.offered.length,matching_count:candidates.length,
            alternatives_to_exact_time:Boolean(exactTime&&!exact.length&&session.offered.length),
            therapist_scope:preferred?'specified therapist only':'all therapists',
            time_preference:filter?.time_preference??null,
            period_start:fromDate.toString(),period_days:filter?.horizon_days??14,
            window_start:filter?.not_before??null,window_end:filter?.not_after??null,
            next_step:session.offered.length?'choose an appointment button':'change preferences or use the search-other-days button'},variables,
            requiredVariables:exactStatus==='unavailable'?Object.keys(variables):preferred?['therapist']:[]};
          session.choices = session.offered.map(slot => ({ action: 'select', slotId: slot.id,
            label: `${new Intl.DateTimeFormat('es-AR',{ timeZone: clinic.time_zone, weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).format(new Date(slot.start))} · ${slot.therapistName}` }));
          if(!candidates.length)session.choices.push({label:'Buscar otros días',action:'more'});
          session.choices.push({ label: 'Hablar con recepción', action: 'human' });
        }
      } catch (error) {
        if (error instanceof DomainError && ['SLOT_UNAVAILABLE','CONFIRMATION_REQUIRED','AGENT_PAUSED','INVALID_DATE_RANGE','APPOINTMENT_CHANGED','APPOINTMENT_NOT_EDITABLE'].includes(error.code)) {
          this.add(session, 'assistant', error.code === 'AGENT_PAUSED' ? 'Recepción está atendiendo esta conversación.' : error.code==='INVALID_DATE_RANGE'?'Elegí una fecha desde hoy y dentro de las próximas seis semanas.':'Ese horario ya no está disponible o necesita una nueva confirmación. Busquemos otro.');
          // Error instructions remain authoritative; avoid rewriting an unverified failure cause.
          narration=null;
          session.selected = null;
          if(session.rescheduling)this.add(session,'assistant','No se aplicó el cambio. Tu reserva conserva su estado actual.');
          session.choices = [{ label: 'Buscar horarios', action: 'start' },{ label:'Hablar con recepción', action:'human' }];
        } else throw error;
      }
      if(narration)await this.narrate(session,replyIndex,narration,verifiedSuffix);
      session.processed.add(input.messageId);
      return this.get(id);
    });
  }

  async reply(id: string, text: string, messageId: string):Promise<ChatView> {
    if(!this.scoped)return this.stored(id,service=>service.reply(id,text,messageId),{key:messageId,payload:{kind:'staff',text}});
    return this.serial(id, async () => {
      await this.get(id);
      const session = this.sessions.get(id);
      if (!session) throw new DomainError('DEMO_SESSION_NOT_FOUND', 404);
      if (session.processed.has(messageId)) return this.get(id);
      await this.repository.db.transaction(async db => {
        await db.query('select id from public.conversations where id=$1 for update', [id]);
        await db.query("update public.conversations set status='human_led',pending_slot_id=null,pending_expires_at=null where id=$1", [id]);
        await db.query("insert into private.audit_events(conversation_id,action,entity_id) values ($1,'staff_replied',$1)", [id]);
      });
      this.add(session, 'staff', text);
      session.selected=null;session.offered=[];session.choices=[];
      session.processed.add(messageId);
      return this.get(id);
    });
  }

  async archive(id:string,archived:boolean):Promise<{id:string;archived:boolean}> {
    if(!this.scoped)return this.stored(id,service=>service.archive(id,archived));
    return this.serial(id,async()=>{
      const result=await this.repository.setConversationArchived(id,archived);
      const session=this.sessions.get(id);
      if(session){session.selected=null;session.rescheduling=null;session.cancellation=null;session.weekly=null;session.offered=[];session.search=null;session.choices=[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];}
      return result;
    });
  }

  async dashboard(fromDate?: string,therapistId?:string) {
    const [clinicResult,professionalRows]=await Promise.all([
      this.repository.db.query('select name,time_zone from public.clinics'),
      this.repository.getTherapists(),
    ]);
    const clinic = clinicResult.rows[0]!;
    let anchor = Temporal.Now.plainDateISO(String(clinic.time_zone)).add({ days: 1 });
    while (anchor.dayOfWeek > 5) anchor = anchor.add({ days: 1 });
    const start = fromDate ? Temporal.PlainDate.from(fromDate) : anchor.subtract({ days: anchor.dayOfWeek - 1 });
    const from = start.toZonedDateTime(String(clinic.time_zone)).toInstant().toString();
    const to = start.add({ days: 7 }).toZonedDateTime(String(clinic.time_zone)).toInstant().toString();
    // Directory information is visible to staff; operational agendas retain their role scope.
    const professionals=professionalRows.map(t=>({id:String(t.id),name:String(t.name),specialty:String(t.specialty)}));
    const therapists = professionals.filter(t=>!therapistId||t.id===therapistId);
    const [appointmentResult,availability,conversationResult]=await Promise.all([
      this.repository.db.query(`select a.id,a.starts_at,a.ends_at,a.therapist_id,a.conversation_id,a.version,p.name as patient_name,t.name as therapist_name
      from public.appointments a join public.patients p on p.id=a.patient_id join public.therapists t on t.id=a.therapist_id
      where a.status='confirmed' and a.starts_at >= $1 and a.starts_at < $2 and ($3::uuid is null or a.therapist_id=$3) order by a.starts_at`, [from,to,therapistId??null]),
      Promise.all(therapists.map(t => this.repository.getAvailability(String(t.id),from,to))),
      therapistId?Promise.resolve({rows:[]}):this.repository.db.query(`select c.id,c.status,c.created_at,p.name as patient_name,p.intake_summary,h.id as handoff_id,h.reason,h.created_at as handoff_at,
      last_message.body as last_message,message_count.total as message_count
      from public.conversations c join public.patient_identities i on i.id=c.identity_id join public.patients p on p.id=i.patient_id
      left join lateral (select body from public.messages where conversation_id=c.id and body is not null order by sequence desc limit 1) last_message on true
      left join lateral (select count(*)::int as total from public.messages where conversation_id=c.id and body is not null) message_count on true
      left join public.handoffs h on h.conversation_id=c.id and h.resolved_at is null
      where c.archived_at is null order by h.created_at desc nulls last,c.created_at desc limit 100`),
    ]);
    const appointments=appointmentResult.rows,slots=availability.flat();
    const conversations=conversationResult.rows.map(row => ({ ...row,id:String(row.id),
        preview: row.last_message ?? (row.intake_summary?'Ficha del paciente guardada':'Conversación'),
        messageCount: Number(row.message_count??0),
      }));
    return { clinic, therapists, professionals, appointments, slots, conversations, weekStart: start.toString(), anchorDate: anchor.toString() };
  }
}

export async function populateDashboard(service: DemoService) {
  const repo = service.repository;
  const therapists = await repo.getTherapists();
  const clinic = (await repo.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
  let date = Temporal.Now.plainDateISO(clinic.time_zone).add({ days: 1 });
  while (date.dayOfWeek > 5) date = date.add({ days: 1 });
  const from = date.toZonedDateTime(clinic.time_zone).toInstant().toString();
  const to = date.add({ days: 7 }).toZonedDateTime(clinic.time_zone).toInstant().toString();
  const names = ['Lucía Fernández', 'Mateo Suárez', 'Valentina Ríos', 'Tomás García', 'Camila Torres', 'Julián López'];
  const picks = [{ t:0, index:1 },{ t:1,index:3 },{ t:0,index:5 },{ t:1,index:8 },{ t:0,index:10 },{ t:1,index:16 }];
  for (let i=0;i<picks.length;i++) {
    const pick = picks[i]!;
    const slots = await repo.getAvailability(String(therapists[pick.t]!.id),from,to);
    const slot = slots[pick.index];
    if (!slot) continue;
    const conversation = await service.create(names[i]!);
    await repo.updatePatientDetails(conversation.id,{phone:`202555010${i}`});
    await repo.selectSlot(String(conversation.id),String(slot.id));
    await repo.book(String(conversation.id),String(slot.id),`seed-appointment-${i}`,true);
    await repo.db.transaction(async db=>{
      await db.query(`insert into public.messages(conversation_id,external_message_id,direction,role,body)
        values ($1,$2,'outbound','assistant','Tu turno de prueba está confirmado. ¡Te esperamos!')`,[conversation.id,randomUUID()]);
      await db.query(`update private.conversation_runtime set state=jsonb_set(state,'{choices}',$2::jsonb) where conversation_id=$1`,
        [conversation.id,JSON.stringify([{label:'Hablar con recepción',action:'human'}])]);
    });
  }
  const human = await service.create('Sofía Morales');
  await service.send(String(human.id),{ messageId:randomUUID(),action:'human',text:'Hola, me gustaría coordinar un horario con recepción.' });
}
