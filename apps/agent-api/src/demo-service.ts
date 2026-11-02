import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ClinicRepository, DomainError } from '../../../packages/db/src/repository.js';
import { isExplicitConfirmation, ProviderError, type AvailabilityInput, type IntentModel, type OfferedSlot } from '../../../packages/agent/src/openrouter.js';
import { normalizeAvailabilitySearch, requestedLocalTime, offeredSelection, rejectsSelectedSlot } from '../../../packages/agent/src/search.js';
import { renderNarration, type NarrationContext } from '../../../packages/agent/src/narration.js';
import { groundedPatientPatch, missingContact } from '../../../packages/core/src/patient.js';

export interface DemoMessage { id: string; role: 'patient' | 'assistant' | 'staff'; text: string; at: string }
export interface DemoChoice { label: string; action: 'start' | 'more' | 'select' | 'confirm' | 'human'; slotId?: string }
interface Session { messages: DemoMessage[]; choices: DemoChoice[]; selected: string | null; processed: Set<string>; offered:OfferedSlot[]; modelRequests:number; clarificationCount:number; providerError:string|null;search:AvailabilityInput|null }
export interface ChatInput { messageId: string; text?: string | undefined; action?: 'start' | 'more' | 'select' | 'confirm' | 'human' | undefined; slotId?: string | undefined }

export class DemoService {
  readonly sessions = new Map<string, Session>();
  // Serialize actions within a conversation while PostgreSQL protects bookings across conversations.
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly repository: ClinicRepository, private readonly intentModel?:IntentModel) {}

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

  async create(name = 'Paciente de prueba') {
    const patient = randomUUID(), identity = randomUUID(), conversation = randomUUID();
    await this.repository.db.transaction(async db => {
      await db.query('insert into public.patients(id,name,name_collected) values ($1,$2,$3)', [patient, name,name!=='Paciente de prueba']);
      await db.query("insert into public.patient_identities(id,patient_id,channel,external_user_id) values ($1,$2,'telegram',$3)", [identity, patient, `demo-${identity}`]);
      await db.query('insert into public.conversations(id,identity_id) values ($1,$2)', [conversation,identity]);
    });
    const session: Session = { messages: [], choices: [{ label: 'Quiero reservar un turno', action: 'start' }, { label: 'Hablar con recepción', action: 'human' }], selected: null, processed: new Set(),offered:[],modelRequests:0,clarificationCount:0,providerError:null,search:null };
    this.add(session, 'assistant', '¡Hola! Soy el asistente de Clínica Demo. Te ayudo a encontrar un turno. ¿Qué te gustaría hacer?');
    this.sessions.set(conversation, session);
    return this.get(conversation);
  }

  async get(id: string) {
    const row = (await this.repository.db.query(`select c.id,c.status,p.name,
      case when c.pending_expires_at>now() then c.pending_slot_id end as pending_slot_id,
      exists(select 1 from public.appointments a where a.conversation_id=c.id and a.status='confirmed') as has_appointment from public.conversations c
      join public.patient_identities i on i.id=c.identity_id join public.patients p on p.id=i.patient_id where c.id=$1 and c.archived_at is null`, [id])).rows[0];
    if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 404);
    let session = this.sessions.get(id);
    if(!session){
      session={messages:[],choices:[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}],selected:row.pending_slot_id?String(row.pending_slot_id):null,processed:new Set(),offered:[],modelRequests:0,clarificationCount:0,providerError:null,search:null};
      this.add(session,'assistant','Recuperé tu ficha guardada. Podés actualizar tus datos o continuar con la consulta.');
      this.sessions.set(id,session);
    }
    const patient=await this.repository.getPatientDetails(id);
    if(session.selected&&!missingContact(patient).length&&!session.choices.some(c=>c.action==='confirm'))session.choices.unshift({label:'Confirmar turno',action:'confirm'});
    return { id:String(row.id),status:String(row.status),name:String(row.name),messages: session?.messages ?? [], choices: row.status === 'active' ? session?.choices ?? [] : [],
      patient,hasAppointment:Boolean(row.has_appointment),
      ai:{provider:this.intentModel?'openrouter':'guided',model:this.intentModel?.model??null,error:session?.providerError??null} };
  }

  async send(id: string, input: ChatInput) {
    return this.serial(id, async () => {
      const current = await this.get(id);
      const session = this.sessions.get(id);
      if (!session) throw new DomainError('DEMO_SESSION_NOT_FOUND', 404);
      if (session.processed.has(input.messageId)) return this.get(id);
      if (session.messages.length > 120) throw new DomainError('DEMO_LIMIT_REACHED', 409);
      let action = input.action ?? (/recepci[oó]n|humano|persona|ayuda|factura|dolor|m[eé]dic/i.test(input.text ?? '') ? 'human' : 'start');
      const text = input.text ?? ({ start: 'Quiero reservar un turno',more:'Buscar en los próximos días', select: 'Ese horario me sirve', confirm: 'Sí, confirmo el turno', human: 'Quiero hablar con recepción' }[action]);
      // Transcript stays in local memory; when enabled, only this conversation's text goes to OpenRouter.
      this.add(session, 'patient', text);
      if (current.status !== 'active') {
        session.processed.add(input.messageId);
        return this.get(id);
      }
      // A rejected selection must not survive a later ambiguous "sí".
      if(session.selected&&input.text&&rejectsSelectedSlot(input.text)){
        session.selected=null;
        await this.repository.db.query("update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1 and status='active'",[id]);
        session.choices=[{label:'Buscar otros horarios',action:'start'}];
      }
      let filter:AvailabilityInput|null=input.action==='more'&&session.search?{...session.search,date:null,horizon_days:14}:null;
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
              patient:{name:current.patient.name_collected?current.patient.name:null,phone:current.patient.phone,insurance:current.patient.insurance,summary:current.patient.intake_summary,missing:missingContact(current.patient)},hasAppointment:current.hasAppointment,search:session.search,
              offered:session.offered,selectedSlotId:session.selected,history:session.messages.map(m=>({role:m.role,text:m.text}))});
            session.providerError=null;
            if((await this.get(id)).status!=='active'){session.processed.add(input.messageId);return this.get(id);}
            if(decision.kind==='patient'){
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
              const unsafeClaim=/\b(reservad[oa]s?|confirmad[oa]s?|agendad[oa]s?|booked|confirmed|scheduled|guard[eé]|guardad[oa]s?|actualic[eé]|actualizad[oa]s?|registr[eé])\b|te agend[eé]|\b\d{1,2}:\d{2}\b/i.test(decision.text);
              this.add(session,'assistant',unsafeClaim?'Para reservar, primero elegí un horario de la agenda y confirmalo.':decision.text);
              session.clarificationCount=unsafeClaim?session.clarificationCount+1:0;
              if(session.clarificationCount>=2&&unsafeClaim){await this.repository.escalate(id,'not_understood');this.add(session,'assistant','Voy a pasarle tu consulta a recepción para que te ayuden.');}
              session.processed.add(input.messageId);return this.get(id);
            }
            if(decision.kind!=='handoff'||decision.reason!=='not_understood')session.clarificationCount=0;
            if(decision.kind==='availability'){
              action='start';filter=normalizeAvailabilitySearch(decision.filter,input.text,localNow,clinic.time_zone,therapists,session.search);
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
              // A tool argument never acts as patient consent.
              this.add(session,'assistant',session.selected?'Para confirmar ese turno, tocá «Confirmar turno» o escribí «sí, confirmo».':'Primero tenemos que elegir un horario.');
              session.choices=session.selected?[{label:'Confirmar turno',action:'confirm'},{label:'Ver otros horarios',action:'start'}]:[{label:'Buscar horarios',action:'start'}];
              session.processed.add(input.messageId);return this.get(id);
            }
          }catch(error){
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
          verifiedSuffix=`El turno sería con ${selection.therapist} el ${when}. ${missing.length?`Antes de confirmar, necesito tu ${missing.join(' y ')}.`:'¿Lo confirmás?'}`;
          this.add(session, 'assistant',verifiedSuffix);
          narration={event:'selected',request:text,facts:{booked:false,missing_contact:missing,details_appended_by_backend:true},variables:{}};
          session.choices = [...(!missing.length?[{ label: 'Confirmar turno', action: 'confirm' } as DemoChoice]:[]),{ label: 'Ver otros horarios', action: 'start' }];
        } else if (action === 'confirm') {
          if (!session.selected) throw new DomainError('CONFIRMATION_REQUIRED', 409);
          const missing=missingContact(await this.repository.getPatientDetails(id));
          if(missing.length){this.add(session,'assistant',`Para confirmar el turno necesito tu ${missing.join(' y ')}. El horario todavía no está reservado.`);session.processed.add(input.messageId);return this.get(id);}
          const selected=session.offered.find(slot=>slot.id===session.selected);
          const clinic=(await this.repository.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
          const booked = await this.repository.book(id, session.selected, `demo-${input.messageId}`, true);
          if(booked.status!=='confirmed')throw new Error('Unexpected booking status');
          if(selected){
            const when=new Intl.DateTimeFormat('es-AR',{timeZone:clinic.time_zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(selected.start));
            verifiedSuffix=`${when} · ${selected.therapistName}. En esta demo no enviamos correos.`;
          }else verifiedSuffix='En esta demo no enviamos correos.';
          this.add(session, 'assistant', '¡Listo! Tu turno quedó confirmado y ya aparece en la agenda de la clínica. En esta demo no enviamos correos.');
          narration={event:'booked',request:text,facts:{booking_succeeded:true,notifications_sent:false,details_appended_by_backend:true},variables:{}};
          session.selected = null;
          session.choices = [{ label: 'Hablar con recepción', action: 'human' }];
        } else {
          session.selected=null;
          await this.repository.db.query("update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1 and status='active'",[id]);
          const clinic = (await this.repository.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
          const today=Temporal.Now.plainDateISO(clinic.time_zone);
          const fromDate=filter?.date?Temporal.PlainDate.from(filter.date):today;
          session.search=filter??{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14};
          if(Temporal.PlainDate.compare(fromDate,today)<0||Temporal.PlainDate.compare(fromDate,today.add({days:41}))>0)throw new DomainError('INVALID_DATE_RANGE',400);
          const now=fromDate.toZonedDateTime(clinic.time_zone).toInstant().toString();
          const to=fromDate.add({days:filter?.horizon_days??14}).toZonedDateTime(clinic.time_zone).toInstant().toString();
          const therapists = await this.repository.getTherapists();
          if(filter?.therapist_id&&!therapists.some(t=>t.id===filter.therapist_id))throw new DomainError('SLOT_UNAVAILABLE',409);
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
          }):candidates;
          session.offered=ranked.slice(0,3);
          const limitation=exactStatus==='unavailable'?`A las ${exactTime} no hay turnos disponibles en el período consultado. `:'';
          this.add(session, 'assistant', candidates.length ? `${limitation}${exactTime&&!exact.length?'Te muestro otros horarios disponibles en ese período':'Estos son los próximos horarios disponibles'}. Elegí el que te quede mejor:` : `${limitation}${complete?'No hay horarios que coincidan en el período consultado.':'No encontré horarios que coincidan en los resultados consultados.'} Podés buscar otros días o cambiar tus preferencias.`);
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
        if (error instanceof DomainError && ['SLOT_UNAVAILABLE','CONFIRMATION_REQUIRED','AGENT_PAUSED','INVALID_DATE_RANGE'].includes(error.code)) {
          this.add(session, 'assistant', error.code === 'AGENT_PAUSED' ? 'Recepción está atendiendo esta conversación.' : error.code==='INVALID_DATE_RANGE'?'Elegí una fecha desde hoy y dentro de las próximas seis semanas.':'Ese horario ya no está disponible o necesita una nueva confirmación. Busquemos otro.');
          // Error instructions remain authoritative; avoid rewriting an unverified failure cause.
          narration=null;
          session.selected = null;
          session.choices = [{ label: 'Buscar horarios', action: 'start' },{ label:'Hablar con recepción', action:'human' }];
        } else throw error;
      }
      if(narration)await this.narrate(session,replyIndex,narration,verifiedSuffix);
      session.processed.add(input.messageId);
      return this.get(id);
    });
  }

  async reply(id: string, text: string, messageId: string) {
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
      session.processed.add(messageId);
      return this.get(id);
    });
  }

  async archive(id:string,archived:boolean) {
    return this.serial(id,async()=>{
      const result=await this.repository.setConversationArchived(id,archived);
      const session=this.sessions.get(id);
      if(session){session.selected=null;session.offered=[];session.search=null;session.choices=[{label:'Buscar horarios',action:'start'},{label:'Hablar con recepción',action:'human'}];}
      return result;
    });
  }

  async dashboard(fromDate?: string,therapistId?:string) {
    const clinic = (await this.repository.db.query('select name,time_zone from public.clinics')).rows[0]!;
    let anchor = Temporal.Now.plainDateISO(String(clinic.time_zone)).add({ days: 1 });
    while (anchor.dayOfWeek > 5) anchor = anchor.add({ days: 1 });
    const start = fromDate ? Temporal.PlainDate.from(fromDate) : anchor.subtract({ days: anchor.dayOfWeek - 1 });
    const from = start.toZonedDateTime(String(clinic.time_zone)).toInstant().toString();
    const to = start.add({ days: 7 }).toZonedDateTime(String(clinic.time_zone)).toInstant().toString();
    const therapists = (await this.repository.getTherapists()).filter(t=>!therapistId||t.id===therapistId);
    const appointments = (await this.repository.db.query(`select a.id,a.starts_at,a.ends_at,a.therapist_id,a.conversation_id,p.name as patient_name,t.name as therapist_name
      from public.appointments a join public.patients p on p.id=a.patient_id join public.therapists t on t.id=a.therapist_id
      where a.status='confirmed' and a.starts_at >= $1 and a.starts_at < $2 and ($3::uuid is null or a.therapist_id=$3) order by a.starts_at`, [from,to,therapistId??null])).rows;
    const slots = (await Promise.all(therapists.map(t => this.repository.getAvailability(String(t.id),from,to)))).flat();
    const conversations = therapistId?[]:(await this.repository.db.query(`select c.id,c.status,c.created_at,p.name as patient_name,p.intake_summary,h.id as handoff_id,h.reason,h.created_at as handoff_at
      from public.conversations c join public.patient_identities i on i.id=c.identity_id join public.patients p on p.id=i.patient_id
      left join public.handoffs h on h.conversation_id=c.id and h.resolved_at is null
      where c.archived_at is null order by h.created_at desc nulls last,c.created_at desc limit 100`)).rows.map(row => ({ ...row,id:String(row.id),
        preview: this.sessions.get(String(row.id))?.messages.at(-1)?.text ?? (row.intake_summary?'Ficha del paciente guardada':'Conversación de prueba'),
        messageCount: this.sessions.get(String(row.id))?.messages.length ?? (row.intake_summary||row.handoff_id?1:0),
      }));
    return { clinic, therapists, appointments, slots, conversations, weekStart: start.toString(), anchorDate: anchor.toString() };
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
    const session = service.sessions.get(String(conversation.id))!;
    session.choices = [{ label:'Hablar con recepción',action:'human' }];
    session.messages.push({ id:randomUUID(),role:'assistant',text:'Tu turno de prueba está confirmado. ¡Te esperamos!',at:new Date().toISOString() });
  }
  const human = await service.create('Sofía Morales');
  await service.send(String(human.id),{ messageId:randomUUID(),action:'human',text:'Hola, me gustaría coordinar un horario con recepción.' });
}
