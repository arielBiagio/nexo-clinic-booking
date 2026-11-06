import { t, useLanguage } from './i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { LoadingPlaceholder } from './LoadingPlaceholder';

export function TherapistProfile({therapistId,onSaved,notify}:{therapistId:string;onSaved:()=>void;notify:(message:string)=>void}){
  useLanguage();
  const [name,setName]=useState(''),[specialty,setSpecialty]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;api<{name:string;specialty:string}>(`/therapists/${therapistId}/profile`).then(profile=>{if(active){setName(profile.name);setSpecialty(profile.specialty);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[therapistId]);
  const save=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{await api(`/therapists/${therapistId}/profile`,{name:name.trim(),specialty:specialty.trim()},'PATCH');notify(t("Tu perfil fue actualizado."));onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="panel staff-panel"><h2>{t("Tu perfil profesional")}</h2><p>{t("Este nombre y especialidad se muestran al reservar un turno.")}</p>{loading?<LoadingPlaceholder variant="form" count={2} label={t("Cargando perfil")}/>:<form className="staff-form" onSubmit={save}>
    <label>{t("Nombre profesional")}<input value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70}/></label>
    <label>{t("Especialidad")}<input value={specialty} onChange={e=>setSpecialty(e.target.value)} required minLength={2} maxLength={120}/></label>
    {error&&<p className="form-error" role="alert">{t(error)}</p>}<button className="primary-button" disabled={busy}>{busy?t("Guardando…"):t("Guardar perfil")}</button>
  </form>}</section>;
}
