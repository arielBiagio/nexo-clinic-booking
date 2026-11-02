import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

export function TherapistProfile({therapistId,onSaved,notify}:{therapistId:string;onSaved:()=>void;notify:(message:string)=>void}){
  const [name,setName]=useState(''),[specialty,setSpecialty]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;api<{name:string;specialty:string}>(`/therapists/${therapistId}/profile`).then(profile=>{if(active){setName(profile.name);setSpecialty(profile.specialty);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[therapistId]);
  const save=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{await api(`/therapists/${therapistId}/profile`,{name:name.trim(),specialty:specialty.trim()},'PATCH');notify('Tu perfil fue actualizado.');onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="panel staff-panel"><h2>Tu perfil profesional</h2><p>Este nombre y especialidad se muestran al reservar un turno.</p>{loading?<p>Cargando perfil…</p>:<form className="staff-form" onSubmit={save}>
    <label>Nombre profesional<input value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70}/></label>
    <label>Especialidad<input value={specialty} onChange={e=>setSpecialty(e.target.value)} required minLength={2} maxLength={120}/></label>
    {error&&<p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy}>{busy?'Guardando…':'Guardar perfil'}</button>
  </form>}</section>;
}
