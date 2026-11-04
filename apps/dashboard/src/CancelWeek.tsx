import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api,dateAt,fmtDate,fmtTime } from './api';
import { LoadingPlaceholder } from './LoadingPlaceholder';

interface Week {weekStart:string;weekEnd:string;timeZone:string;appointments:{id:string;version:number;start:string;therapistName:string}[]}
export function CancelWeek({appointmentId,ownAgenda,onCancelled}:{appointmentId:string;ownAgenda:boolean;onCancelled:(count:number)=>void}){
  const [open,setOpen]=useState(false),[week,setWeek]=useState<Week|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const review=async()=>{
    setOpen(true);setWeek(null);setLoading(true);setError('');
    try{setWeek(await api<Week>(`/appointments/${appointmentId}/cancellation-week`));}
    catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };
  const cancel=async()=>{
    if(!week||busy)return;setBusy(true);setError('');
    try{const result=await api<{cancelled:number}>(`/appointments/${appointmentId}/cancellation-week`,{confirmed:true,appointments:week.appointments.map(({id,version})=>({id,version}))});onCancelled(result.cancelled);}
    catch(e){setWeek(null);setError(`${(e as Error).message} Revisá la agenda y volvé a consultar la lista antes de intentarlo otra vez.`);}
    finally{setBusy(false);}
  };
  return <section className="cancel-week" aria-label="Cancelar la semana">
    {!open?<button type="button" className="secondary-button full" onClick={()=>void review()}><Trash2 size={16}/>Cancelar turnos de esta semana</button>:<>
      <strong>Cancelar la semana del paciente</strong>
      <p>Solo los turnos futuros de lunes a domingo{ownAgenda?' en tu agenda':''}. Revisá la lista antes de confirmar.</p>
      {loading&&<LoadingPlaceholder variant="list" label="Buscando turnos de la semana"/>}
      {week&&<><p>{fmtDate(week.weekStart)} – {fmtDate(week.weekEnd)} · {week.timeZone}</p><ul>{week.appointments.map(a=><li key={a.id}><span>{fmtDate(dateAt(a.start,week.timeZone),{weekday:'short',day:'numeric',month:'short'})} · {fmtTime(a.start,week.timeZone)}</span><span>{a.therapistName}</span></li>)}</ul><button className="danger-button full" type="button" disabled={busy} onClick={()=>void cancel()}><Trash2 size={16}/>{busy?'Cancelando…':`Confirmar cancelación de ${week.appointments.length} ${week.appointments.length===1?'turno':'turnos'}`}</button></>}
      {error&&<><p className="error-message" role="alert">{error}</p><button className="secondary-button" disabled={busy||loading} onClick={()=>void review()}>Revisar turnos</button></>}
      <button type="button" className="secondary-button" disabled={busy} onClick={()=>{setOpen(false);setWeek(null);setError('');}}>Volver</button>
    </>}
  </section>;
}
