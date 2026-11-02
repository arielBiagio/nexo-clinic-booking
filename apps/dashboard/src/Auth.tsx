import { useEffect, useState, type FormEvent } from 'react';
import { HeartPulse, LockKeyhole, LogIn } from 'lucide-react';
import { api } from './api';
import { App } from './App';
import type { StaffUser } from './types';

export function AuthGate(){
  const [loading,setLoading]=useState(true),[mode,setMode]=useState<'staff'|'demo'>('staff'),[setup,setSetup]=useState(false),[user,setUser]=useState<StaffUser|null>(null);
  const [email,setEmail]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=async()=>{
    setLoading(true);setError('');
    try{
      const status=await api<{mode:'staff'|'demo';setupRequired:boolean}>('/auth/status');setMode(status.mode);setSetup(status.setupRequired);
      try{const session=await api<{user:StaffUser}>('/auth/me');setUser(session.user);}catch{setUser(null);}
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };
  useEffect(()=>{void load();const expired=()=>{setUser(null);setPassword('');setError('Tu sesión terminó. Ingresá nuevamente.');};window.addEventListener('nexo-auth-required',expired);return()=>window.removeEventListener('nexo-auth-required',expired);},[]);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setError('');if(setup&&password!==confirmation){setError('Las contraseñas no coinciden.');return;}
    setBusy(true);
    try{
      const session=await api<{user:StaffUser}>(setup?'/auth/setup':'/auth/login',{email:email.trim(),password,...(setup?{name:name.trim()}:{})});
      setUser(session.user);setSetup(false);setPassword('');setConfirmation('');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const logout=async()=>{setBusy(true);setError('');try{await api('/auth/logout',{});setUser(null);sessionStorage.removeItem('nexo-demo-chat');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  if(loading)return <main className="auth-screen"><p>Cargando Nexo…</p></main>;
  if(user)return <App user={user} accessMode={mode} onLogout={()=>void logout()} onUserChanged={()=>{void api<{user:StaffUser}>('/auth/me').then(session=>setUser(session.user)).catch(()=>setUser(null));}}/>;
  return <main className="auth-screen"><section className="auth-card panel">
    <a href="#" className="brand"><span className="brand-mark"><span/><span/><span/></span><span>nexo<span className="brand-dot">.</span></span></a>
    <span className="auth-icon"><HeartPulse size={25}/></span>
    <h1>{setup?'Creá tu acceso de administrador':'Ingresá a tu clínica'}</h1>
    <p>{setup?'Elegí una contraseña para el correo de administración configurado.':'Usá el correo y la contraseña de tu cuenta del equipo.'}</p>
    <form onSubmit={submit}>
      {setup&&<label>Tu nombre<input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={70}/></label>}
      <label>Correo electrónico<input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254}/></label>
      <label>Contraseña<input type="password" autoComplete={setup?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} required minLength={setup?12:1} maxLength={128}/></label>
      {setup&&<><small>Al menos doce caracteres.</small><label>Repetí la contraseña<input type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={12} maxLength={128}/></label></>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full" disabled={busy}>{busy?'Ingresando…':setup?'Crear mi acceso':'Ingresar'}<LogIn size={17}/></button>
    </form>
    <span className="auth-note"><LockKeyhole size={14}/>Acceso exclusivo para el equipo de la clínica</span>
  </section></main>;
}
