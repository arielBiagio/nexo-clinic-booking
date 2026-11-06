import { t, useLanguage } from './i18n';
import { useEffect, useId, useState } from 'react';
import {ChevronRight} from 'lucide-react';
import { api } from './api';
import type { PatientDetails } from './types';
import { LoadingPlaceholder } from './LoadingPlaceholder';

export function PatientCard({conversationId,onSaved,collapsible=false,readOnly=false}:{conversationId:string;onSaved?:()=>void;collapsible?:boolean;readOnly?:boolean}) {
  useLanguage();
  const uid=useId();
  const [expanded,setExpanded]=useState(!collapsible);
  const [patient,setPatient]=useState<PatientDetails|null>(null),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [form,setForm]=useState({name:'',phone:'',insurance:'',reported_reason:'',additional_info:''});
  useEffect(()=>{let active=true;setPatient(null);setEditing(false);setError('');setExpanded(!collapsible);
    const load=()=>api<PatientDetails>(`/conversations/${conversationId}/patient`).then(p=>{if(active)setPatient(p);}).catch(e=>{if(active)setError(e.message);});
    void load();const timer=setInterval(()=>void load(),4000);return()=>{active=false;clearInterval(timer);};
  },[conversationId,collapsible]);
  const edit=()=>{if(!patient||readOnly)return;setForm({name:patient.name_collected?patient.name:'',phone:patient.phone??'',insurance:patient.insurance??'',reported_reason:patient.reported_reason??'',additional_info:patient.additional_info??''});setError('');setEditing(true);};
  const save=async()=>{setBusy(true);setError('');try{setPatient(await api<PatientDetails>(`/conversations/${conversationId}/patient`,form,'PATCH'));setEditing(false);onSaved?.();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const heading=<><strong>{t("Ficha del paciente")}</strong>{patient&&<span className={`status-pill ${patient.name_collected&&patient.phone?'green':'amber'}`}>{patient.name_collected&&patient.phone?t("Contacto completo"):t("Falta contacto")}</span>}</>;
  return <section className="patient-card" aria-label={t("Ficha del paciente")}>{collapsible?<button type="button" className="patient-card-heading patient-card-toggle" aria-expanded={expanded} aria-controls={uid} onClick={()=>setExpanded(value=>!value)}><ChevronRight size={16} className={expanded?'expanded':''}/>{heading}</button>:<div className="patient-card-heading">{heading}</div>}
    <div id={uid} hidden={!expanded}>
    {!patient&&!error&&<LoadingPlaceholder variant="details" label={t("Cargando ficha del paciente")}/>}
    {patient&&!editing&&<><dl><div><dt>{t("Nombre")}</dt><dd>{patient.name_collected?patient.name:t("Pendiente")}</dd></div><div><dt>{t("Teléfono")}</dt><dd>{patient.phone??t("Pendiente")}</dd></div><div><dt>{t("Seguro de salud")}</dt><dd>{patient.insurance||t("Sin informar")}</dd></div><div><dt>{t("Diagnóstico referido")}</dt><dd>{patient.reported_reason||t("Sin informar")}</dd></div>{patient.additional_info&&<div><dt>{t("Más datos")}</dt><dd>{patient.additional_info}</dd></div>}</dl>{!readOnly&&<button className="secondary-button" type="button" onClick={edit}>{t("Editar ficha")}</button>}</>}
    {editing&&<form onSubmit={e=>{e.preventDefault();void save();}}><p className="muted">{t("Nombre y teléfono obligatorios para reservar. Los demás datos son opcionales.")}</p>{([
      ['name',t("Nombre *"),70],['phone',t("Teléfono *"),40],['insurance',t("Seguro de salud"),120],['reported_reason',t("Motivo o diagnóstico referido (no verificado)"),400],['additional_info',t("Información relevante"),600],
    ] as const).map(([key,label,max])=><label key={key} htmlFor={`${uid}-${key}`}>{t(label)}{key==='reported_reason'||key==='additional_info'?<textarea id={`${uid}-${key}`} maxLength={max} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>:<input id={`${uid}-${key}`} type={key==='phone'?'tel':'text'} required={key==='name'||key==='phone'} minLength={key==='name'?2:undefined} maxLength={max} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>}</label>)}<div className="patient-card-actions"><button className="secondary-button" type="button" disabled={busy} onClick={()=>setEditing(false)}>{t("Cancelar")}</button><button className="primary-button" disabled={busy} type="submit">{busy?t("Guardando…"):t("Guardar ficha")}</button></div></form>}
    {error&&<p className="error-message" role="alert">{t(error)}</p>}
    </div>
  </section>;
}
