import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, Clock3, ShieldCheck } from 'lucide-react';
import { api, addDays, dayInstant, fmtDate, fmtTime } from './api';
import type { Appointment,Dashboard, Slot } from './types';
import { LoadingPlaceholder } from './LoadingPlaceholder';
interface PatientMatch {id:string;name:string;name_collected:boolean;phone:string|null;conversation_id:string|null;telegram:boolean;archived:boolean}

export function Booking({data,initialDate,initialTherapist,initialSlot,ownTherapistId,editing,onDone,notify}:{data:Dashboard;initialDate?:string;initialTherapist?:string;initialSlot?:string;ownTherapistId?:string|undefined;editing?:Appointment;onDone:()=>void;notify:(s:string)=>void}) {
  const [name,setName]=useState('');
  const [phone,setPhone]=useState('');
  const [therapist,setTherapist]=useState(initialTherapist??data.therapists[0]!.id);
  const [date,setDate]=useState(initialDate??data.anchorDate);
  const [slots,setSlots]=useState<Slot[]>([]),[selected,setSelected]=useState<Slot|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [lookup,setLookup]=useState(''),[matches,setMatches]=useState<PatientMatch[]>([]),[existing,setExisting]=useState<PatientMatch|null>(null),[searching,setSearching]=useState(false);
  const [lookupError,setLookupError]=useState(''),[searched,setSearched]=useState(false);
  const requestId=useRef(crypto.randomUUID());
  const zone=data.clinic.time_zone;
  useEffect(()=>{
    setMatches([]);setLookupError('');setSearched(false);
    if(editing||lookup.trim().length<2){setSearching(false);return;}
    let active=true;setSearching(true);
    const timer=setTimeout(()=>{void api<PatientMatch[]>(`/patients/search?q=${encodeURIComponent(lookup.trim())}`).then(rows=>{if(active){setMatches(rows);setSearched(true);}}).catch(e=>{if(active)setLookupError(e.message);}).finally(()=>{if(active)setSearching(false);});},300);
    return()=>{active=false;clearTimeout(timer);};
  },[lookup,editing]);
  useEffect(()=>{let active=true;setLoading(true);setSelected(null);setError('');
    const params=new URLSearchParams({therapistId:therapist,from:dayInstant(date,zone),to:dayInstant(addDays(date,1),zone)});
    api<Slot[]>(`/availability?${params}`).then(value=>{if(active){setSlots(value);if(initialSlot)setSelected(value.find(slot=>slot.id===initialSlot)??null);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[therapist,date,zone]);
  const save=async()=>{
    if(!selected||!editing&&(!name.trim()||!phone.trim()))return;setBusy(true);setError('');
    try{
      if(editing){
        await api(`/appointments/${editing.id}/reschedule`,{slotId:selected.id,expectedVersion:editing.version,confirmed:true},'POST',{'Idempotency-Key':requestId.current});
        notify('Turno reprogramado. El horario anterior quedó libre.');onDone();return;
      }
      await api(`/therapists/${ownTherapistId??therapist}/appointments`,{slotId:selected.id,confirmed:true,name:name.trim(),phone:phone.trim(),...(existing?{patientId:existing.id}:{})},'POST',{'Idempotency-Key':requestId.current});
      notify('Turno reservado. Ya aparece en tu agenda.');onDone();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <form className="booking-form" onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="form-intro">{editing?`Elegí un nuevo día y horario para ${editing.patient_name}. Su reserva actual se mantiene hasta confirmar el cambio.`:'Elegí un profesional y confirmá el horario para tu paciente de prueba.'}</p>
    {!editing&&<>
    {existing?<div className="booking-summary"><div><strong>Ficha existente: {existing.name_collected?existing.name:'Nombre pendiente'}</strong><span>{existing.archived?'Se conserva su historial archivado y se reutiliza la ficha':existing.telegram?'Vinculada a Telegram':'Se conservarán su ficha e historial'}</span>{(!existing.name_collected||!existing.phone)&&<span>Completá los datos de contacto que faltan antes de reservar.</span>}</div><button type="button" className="secondary-button" onClick={()=>{setExisting(null);setName('');setPhone('');requestId.current=crypto.randomUUID();}}>Cambiar ficha</button></div>:<>
      <label>Buscar ficha existente<input value={lookup} onChange={e=>setLookup(e.target.value)} maxLength={70} placeholder="Nombre o teléfono" autoComplete="off"/></label>
      {searching&&<LoadingPlaceholder variant="list" count={2} label="Buscando fichas"/>}
      {!searching&&!!matches.length&&<div className="chat-choices" aria-label="Fichas encontradas">{matches.map(patient=><button key={patient.id} type="button" onClick={()=>{setExisting(patient);setName(patient.name_collected?patient.name:'');setPhone(patient.phone??'');setLookup('');setMatches([]);requestId.current=crypto.randomUUID();}}>{patient.name_collected?patient.name:'Nombre pendiente'} · {patient.phone||'Teléfono pendiente'}{patient.archived?' · Historial archivado':patient.telegram?' · Telegram':''}</button>)}</div>}
      {!searching&&searched&&!matches.length&&!lookupError&&<p className="privacy-note" role="status">No encontramos fichas con ese nombre o teléfono. Para un paciente nuevo, completá los datos debajo.</p>}
      {lookupError&&<p className="error-message" role="alert">{lookupError}</p>}
      <p className="privacy-note">Buscá entre las fichas de toda la clínica, aunque se hayan atendido con otro profesional. Elegí una existente para conservar su historial y evitar duplicados.</p>
    </>}
    <label>Nombre del paciente<input placeholder="Ej. Martina Demo" value={name} readOnly={!!existing?.name_collected} required maxLength={70} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
    <label>Teléfono del paciente<input type="tel" placeholder="Ej. 202 555 0108" value={phone} readOnly={!!existing?.phone} required maxLength={40} onChange={e=>setPhone(e.target.value)} autoComplete="off"/></label></>}
    <div className="form-row"><label>Profesional<select value={therapist} onChange={e=>setTherapist(e.target.value)}>{data.therapists.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Fecha<input aria-label="Fecha del turno" type="date" value={date} required onInput={e=>{if(e.currentTarget.value)setDate(e.currentTarget.value);}}/></label></div>
    <div className="field-label"><Clock3 size={15}/>Horarios disponibles <span>{zone.replaceAll('_',' ')}</span></div>
    <div className="slot-picker">{loading?<LoadingPlaceholder variant="slots" count={6} label="Buscando horarios"/>:slots.length?slots.map(slot=><button key={slot.id} type="button" className={selected?.id===slot.id?'selected':''} onClick={()=>setSelected(slot)}>{fmtTime(slot.starts_at,zone)}{selected?.id===slot.id&&<Check size={13}/>}</button>):<p className="no-slots">No hay horarios disponibles ese día. Probá con otra fecha o profesional.</p>}</div>
    {selected&&<div className="booking-summary"><CalendarDays size={21}/><div><strong>{fmtDate(date,{weekday:'long',day:'numeric',month:'long'})}, {fmtTime(selected.starts_at,zone)}</strong><span>{data.therapists.find(t=>t.id===therapist)?.name} · {Math.round((Date.parse(selected.ends_at)-Date.parse(selected.starts_at))/60_000)} minutos</span></div></div>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    <p className="privacy-note"><ShieldCheck size={14}/>{editing?'Si el paciente usa Telegram, el cambio quedará pendiente de envío a su chat.':'La reserva puede generar avisos al paciente y al profesional según sus canales conectados.'}</p>
    <button className="primary-button full" disabled={!selected||!editing&&(!name.trim()||!phone.trim())||busy} type="submit">{busy?'Guardando…':<><Check size={17}/>{editing?'Confirmar cambio':'Confirmar reserva'}</>}</button>
  </form>;
}
