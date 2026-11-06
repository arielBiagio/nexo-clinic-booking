import { t, useLanguage } from './i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import type { StaffUser, Therapist } from './types';
import { ProfessionalDirectory } from './ProfessionalDirectory';
import { LoadingPlaceholder } from './LoadingPlaceholder';

export function TeamDirectory({professionals}:{professionals:Therapist[]}){
  useLanguage();
  return <section className="panel staff-panel"><h2>{t("Profesionales")}</h2><ProfessionalDirectory professionals={professionals}/></section>;
}

interface Member extends Omit<StaffUser,'therapistId'> {active:boolean;therapist_id:string|null}
const roleLabel={admin:'Administrador',reception:'Recepción',therapist:'Terapeuta'};
function MemberRow({member,therapists,onSaved,notify}:{member:Member;therapists:Therapist[];onSaved:()=>void;notify:(text:string)=>void}){
  useLanguage();
  const [role,setRole]=useState(member.role),[therapist,setTherapist]=useState(member.therapist_id??''),[busy,setBusy]=useState(false);
  const save=async(active:boolean)=>{setBusy(true);try{await api(`/staff/${member.id}`,{role,active,therapistId:role==='therapist'?therapist||null:null},'PATCH');notify(t("Acceso actualizado. La cuenta deberá volver a ingresar."));onSaved();}catch(e){notify((e as Error).message);}finally{setBusy(false);}};
  return <article className="staff-member"><div><strong>{member.name}</strong><span>{member.email}</span><small>{member.active?t("Activo"):t("Desactivado")}</small></div>
    <label><span className="sr-only">{t("Rol de")}{' '}{member.name}</span><select value={role} onChange={e=>setRole(e.target.value as StaffUser['role'])}>{Object.entries(roleLabel).map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select></label>
    {role==='therapist'&&<label><span className="sr-only">{t("Profesional asociado")}</span><select value={therapist} onChange={e=>setTherapist(e.target.value)}><option value="">{t("Elegí profesional")}</option>{therapists.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
    <button className="secondary-button" disabled={busy||role==='therapist'&&!therapist} onClick={()=>void save(member.active)}>{t("Guardar rol")}</button>
    <button className="secondary-button" disabled={busy} onClick={()=>void save(!member.active)}>{member.active?t("Desactivar"):t("Reactivar")}</button>
  </article>;
}
export function Staff({therapists,professionals=therapists,notify,onRefresh,focusCreate=0}:{therapists:Therapist[];professionals?:Therapist[];notify:(text:string)=>void;onRefresh:()=>void;focusCreate?:number}){
  useLanguage();
  const createForm=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(focusCreate){createForm.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});createForm.current?.querySelector('input')?.focus({preventScroll:true});}},[focusCreate]);
  const [members,setMembers]=useState<Member[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState<StaffUser['role']>('reception'),[specialty,setSpecialty]=useState(()=>t('Fisioterapia'));
  const load=async()=>{try{setMembers((await api<{staff:Member[]}>('/staff')).staff);setError('');}catch(e){setError((e as Error).message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const create=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{
    await api('/staff',{name:name.trim(),email:email.trim(),password,role,...(role==='therapist'?{specialty:specialty.trim()}:{})});
    setName('');setEmail('');setPassword('');setSpecialty(t('Fisioterapia'));notify(role==='therapist'?t("Terapeuta y acceso creados. Configurá sus horarios en Disponibilidad."):t("Acceso creado. No se envió ningún correo."));onRefresh();await load();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="staff-layout"><div className="staff-overview"><section className="panel staff-panel"><h2>{t("Equipo y permisos")}</h2><p>{t("Administración y recepción operan la clínica. Cada terapeuta consulta su propia agenda.")}</p>
      {loading?<LoadingPlaceholder variant="list" label={t("Cargando accesos del equipo")}/>:members.map(member=><MemberRow key={`${member.id}-${member.role}-${member.active}-${member.therapist_id}`} member={member} therapists={therapists} onSaved={()=>void load()} notify={notify}/>)}</section><TeamDirectory professionals={professionals}/></div>
    <section className="panel staff-panel"><h2>{t("Crear acceso")}</h2><form ref={createForm} onSubmit={create} className="staff-form">
      <label>{role==='therapist'?t("Nombre del terapeuta"):t("Nombre")}<input value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70} autoComplete="off"/></label>
      <label>{t("Correo")}<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254} autoComplete="off"/></label>
      <label>{t("Contraseña inicial")}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password"/></label>
      <label>{t("Rol")}<select value={role} onChange={e=>setRole(e.target.value as StaffUser['role'])}>{Object.entries(roleLabel).map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select></label>
      {role==='therapist'&&<label>{t("Especialidad")}<input value={specialty} onChange={e=>setSpecialty(e.target.value)} required minLength={2} maxLength={120}/></label>}
      <p>{t("Compartí la contraseña inicial por un medio privado. No enviamos correos automáticamente.")}</p>
      {error&&<p role="alert" className="form-error">{t(error)}</p>}<button className="primary-button" disabled={busy}>{busy?t("Creando…"):t("Crear acceso")}</button>
    </form></section></div>;
}
