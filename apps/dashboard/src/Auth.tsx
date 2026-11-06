import { t, useLanguage } from './i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { HeartPulse, LockKeyhole, LogIn } from 'lucide-react';
import { api } from './api';
import { LanguagePicker } from './LanguagePicker';
import { App } from './App';
import type { StaffUser } from './types';

export function AuthGate(){
  const language=useLanguage();
  const [loading,setLoading]=useState(true),[mode,setMode]=useState<'staff'|'demo'>('staff'),[setup,setSetup]=useState(false),[user,setUser]=useState<StaffUser|null>(null);
  const [email,setEmail]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!user)document.title=language==='en'?'Nexo · Clinic workspace':'Nexo · Tu clínica';},[language,user]);
  const load=async()=>{
    setLoading(true);setError('');
    try{
      const session=await api<{mode:'staff'|'demo';setupRequired:boolean;user:StaffUser|null}>('/auth/session');
      setMode(session.mode);setSetup(session.setupRequired);setUser(session.user);
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };
  useEffect(()=>{void load();const expired=()=>{setUser(null);setPassword('');setError(t("Tu sesión terminó. Ingresá nuevamente."));};window.addEventListener('nexo-auth-required',expired);return()=>window.removeEventListener('nexo-auth-required',expired);},[]);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setError('');if(setup&&password!==confirmation){setError(t("Las contraseñas no coinciden."));return;}
    setBusy(true);
    try{
      const session=await api<{user:StaffUser}>(setup?'/auth/setup':'/auth/login',{email:email.trim(),password,...(setup?{name:name.trim()}:{})});
      setUser(session.user);setSetup(false);setPassword('');setConfirmation('');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const logout=async()=>{setBusy(true);setError('');try{await api('/auth/logout',{});setUser(null);sessionStorage.removeItem('nexo-demo-chat');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  if(loading)return <main className="auth-screen" aria-busy="true"><span className="sr-only" role="status">{t("Verificando acceso")}</span></main>;
  if(user)return <App user={user} accessMode={mode} onLogout={()=>void logout()} onUserChanged={()=>{void api<{user:StaffUser}>('/auth/me').then(session=>setUser(session.user)).catch(()=>setUser(null));}}/>;
  return <main className="auth-screen"><section className="auth-card panel"><div className="auth-language"><LanguagePicker/></div>
    <a href="#" className="brand"><span className="brand-mark"><span/><span/><span/></span><span>nexo<span className="brand-dot">.</span></span></a>
    <span className="auth-icon"><HeartPulse size={25}/></span>
    <h1>{setup?t("Creá tu acceso de administrador"):t("Ingresá a tu clínica")}</h1>
    <p>{setup?t("Elegí una contraseña para el correo de administración configurado."):t("Usá el correo y la contraseña de tu cuenta del equipo.")}</p>
    <form onSubmit={submit}>
      {setup&&<label>{t("Tu nombre")}<input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70}/></label>}
      <label>{t("Correo electrónico")}<input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254}/></label>
      <label>{t("Contraseña")}<input type="password" autoComplete={setup?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} required minLength={setup?12:1} maxLength={128}/></label>
      {setup&&<><small>{t("Al menos doce caracteres.")}</small><label>{t("Repetí la contraseña")}<input type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={12} maxLength={128}/></label></>}
      {error&&<p className="form-error" role="alert">{t(error)}</p>}
      <button className="primary-button full" disabled={busy}>{busy?t("Ingresando…"):setup?t("Crear mi acceso"):t("Ingresar")}<LogIn size={17}/></button>
    </form>
    <span className="auth-note"><LockKeyhole size={14}/>{t("Acceso exclusivo para el equipo de la clínica")}</span>
  </section></main>;
}
