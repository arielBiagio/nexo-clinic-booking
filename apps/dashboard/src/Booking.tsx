import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, Clock3, ShieldCheck } from 'lucide-react';
import { api, addDays, dayInstant, fmtDate, fmtTime } from './api';
import type { Dashboard, Slot } from './types';

export function Booking({data,initialDate,initialTherapist,initialSlot,onDone,notify}:{data:Dashboard;initialDate?:string;initialTherapist?:string;initialSlot?:string;onDone:()=>void;notify:(s:string)=>void}) {
  const [name,setName]=useState('');
  const [phone,setPhone]=useState('');
  const [therapist,setTherapist]=useState(initialTherapist??data.therapists[0]!.id);
  const [date,setDate]=useState(initialDate??data.anchorDate);
  const [slots,setSlots]=useState<Slot[]>([]),[selected,setSelected]=useState<Slot|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const conversation=useRef<string|null>(null);
  const zone=data.clinic.time_zone;
  useEffect(()=>{let active=true;setLoading(true);setSelected(null);setError('');
    const params=new URLSearchParams({therapistId:therapist,from:dayInstant(date,zone),to:dayInstant(addDays(date,1),zone)});
    api<Slot[]>(`/availability?${params}`).then(value=>{if(active){setSlots(value);if(initialSlot)setSelected(value.find(slot=>slot.id===initialSlot)??null);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[therapist,date,zone]);
  const save=async()=>{
    if(!selected||!name.trim()||!phone.trim())return;setBusy(true);setError('');
    try{
      if(!conversation.current)conversation.current=(await api<{id:string}>('/demo/conversations',{name:name.trim()})).id;
      await api(`/conversations/${conversation.current}/patient`,{name:name.trim(),phone:phone.trim()},'PATCH');
      await api(`/conversations/${conversation.current}/selection`,{slotId:selected.id});
      await api(`/conversations/${conversation.current}/book`,{slotId:selected.id,confirmed:true},'POST',{'Idempotency-Key':`manual-${selected.id}-${conversation.current}`});
      notify('Turno reservado. Ya aparece en tu agenda.');onDone();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <form className="booking-form" onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="form-intro">Elegí un profesional y confirmá el horario para tu paciente de prueba.</p>
    <label>Nombre del paciente<input placeholder="Ej. Martina Demo" value={name} required maxLength={70} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
    <label>Teléfono del paciente<input type="tel" placeholder="Ej. 202 555 0108" value={phone} required maxLength={40} onChange={e=>setPhone(e.target.value)} autoComplete="off"/></label>
    <div className="form-row"><label>Profesional<select value={therapist} onChange={e=>setTherapist(e.target.value)}>{data.therapists.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Fecha<input aria-label="Fecha del turno" type="date" value={date} required onInput={e=>{if(e.currentTarget.value)setDate(e.currentTarget.value);}}/></label></div>
    <div className="field-label"><Clock3 size={15}/>Horarios disponibles <span>{zone.replaceAll('_',' ')}</span></div>
    <div className="slot-picker">{loading?<p className="muted">Buscando horarios…</p>:slots.length?slots.map(slot=><button key={slot.id} type="button" className={selected?.id===slot.id?'selected':''} onClick={()=>setSelected(slot)}>{fmtTime(slot.starts_at,zone)}{selected?.id===slot.id&&<Check size={13}/>}</button>):<p className="no-slots">No hay horarios disponibles ese día. Probá con otra fecha o profesional.</p>}</div>
    {selected&&<div className="booking-summary"><CalendarDays size={21}/><div><strong>{fmtDate(date,{weekday:'long',day:'numeric',month:'long'})}, {fmtTime(selected.starts_at,zone)}</strong><span>{data.therapists.find(t=>t.id===therapist)?.name} · {Math.round((Date.parse(selected.ends_at)-Date.parse(selected.starts_at))/60_000)} minutos</span></div></div>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    <p className="privacy-note"><ShieldCheck size={14}/>Usá datos ficticios. No se enviarán emails ni notificaciones.</p>
    <button className="primary-button full" disabled={!selected||!name.trim()||!phone.trim()||busy} type="submit">{busy?'Reservando…':<><Check size={17}/>Confirmar reserva</>}</button>
  </form>;
}
