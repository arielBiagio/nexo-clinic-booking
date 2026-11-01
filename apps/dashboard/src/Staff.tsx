import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import type { StaffUser, Therapist } from './types';

interface Member extends Omit<StaffUser,'therapistId'> {active:boolean;therapist_id:string|null}
const roleLabel={admin:'Administrador',reception:'Recepción',therapist:'Terapeuta'};
function MemberRow({member,therapists,onSaved,notify}:{member:Member;therapists:Therapist[];onSaved:()=>void;notify:(text:string)=>void}){
  const [role,setRole]=useState(member.role),[therapist,setTherapist]=useState(member.therapist_id??''),[busy,setBusy]=useState(false);
  const save=async(active:boolean)=>{setBusy(true);try{await api(`/staff/${member.id}`,{role,active,therapistId:role==='therapist'?therapist||null:null},'PATCH');notify('Acceso actualizado. La cuenta deberá volver a ingresar.');onSaved();}catch(e){notify((e as Error).message);}finally{setBusy(false);}};
  return <article className="staff-member"><div><strong>{member.name}</strong><span>{member.email}</span><small>{member.active?'Activo':'Desactivado'}</small></div>
    <label><span className="sr-only">Rol de {member.name}</span><select value={role} onChange={e=>setRole(e.target.value as StaffUser['role'])}>{Object.entries(roleLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    {role==='therapist'&&<label><span className="sr-only">Profesional asociado</span><select value={therapist} onChange={e=>setTherapist(e.target.value)}><option value="">Elegí profesional</option>{therapists.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
    <button className="secondary-button" disabled={busy||role==='therapist'&&!therapist} onClick={()=>void save(member.active)}>Guardar rol</button>
    <button className="secondary-button" disabled={busy} onClick={()=>void save(!member.active)}>{member.active?'Desactivar':'Reactivar'}</button>
  </article>;
}
export function Staff({therapists,notify,onRefresh}:{therapists:Therapist[];notify:(text:string)=>void;onRefresh:()=>void}){
  const [members,setMembers]=useState<Member[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState<StaffUser['role']>('reception'),[specialty,setSpecialty]=useState('Fisioterapia');
  const load=async()=>{try{setMembers((await api<{staff:Member[]}>('/staff')).staff);setError('');}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[]);
  const create=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{
    await api('/staff',{name:name.trim(),email:email.trim(),password,role,...(role==='therapist'?{specialty:specialty.trim()}:{})});
    setName('');setEmail('');setPassword('');setSpecialty('Fisioterapia');notify(role==='therapist'?'Terapeuta y acceso creados. Configurá sus horarios en Disponibilidad.':'Acceso creado. No se envió ningún correo.');onRefresh();await load();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="staff-layout"><section className="panel staff-panel"><h2>Equipo y permisos</h2><p>Administración y recepción operan la clínica. Cada terapeuta consulta su propia agenda.</p>
    {members.map(member=><MemberRow key={`${member.id}-${member.role}-${member.active}-${member.therapist_id}`} member={member} therapists={therapists} onSaved={()=>void load()} notify={notify}/>)}</section>
    <section className="panel staff-panel"><h2>Crear acceso</h2><form onSubmit={create} className="staff-form">
      <label>{role==='therapist'?'Nombre del terapeuta':'Nombre'}<input value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70} autoComplete="off"/></label>
      <label>Correo<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254} autoComplete="off"/></label>
      <label>Contraseña inicial<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password"/></label>
      <label>Rol<select value={role} onChange={e=>setRole(e.target.value as StaffUser['role'])}>{Object.entries(roleLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {role==='therapist'&&<label>Especialidad<input value={specialty} onChange={e=>setSpecialty(e.target.value)} required minLength={2} maxLength={120}/></label>}
      <p>Compartí la contraseña inicial por un medio privado. No enviamos correos automáticamente.</p>
      {error&&<p role="alert" className="form-error">{error}</p>}<button className="primary-button" disabled={busy}>{busy?'Creando…':'Crear acceso'}</button>
    </form></section></div>;
}
