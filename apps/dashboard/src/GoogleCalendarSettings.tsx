import { useEffect,useState } from 'react';
import { CalendarDays,ExternalLink,RefreshCw,Unplug } from 'lucide-react';
import { api } from './api';
import { LoadingPlaceholder } from './LoadingPlaceholder';

type Status={eligible:boolean;configured:boolean;status?:'connected'|'reauth_required'|'disconnected';email?:string;emailNotifications?:'configured'|'permission_required'|'retry_pending';lastSyncedAt?:string|null;pending?:number;failed?:number;error?:string|null};
const callbackMessages:Record<string,string>={connected:'Cuenta conectada. Tus próximos turnos se copiarán a Google.',denied:'No autorizaste la conexión. Podés volver a intentarlo.',expired:'La autorización venció. Volvé a iniciar la conexión desde aquí.',account_in_use:'Esa cuenta de Google ya está conectada a otro terapeuta. Elegí tu propia cuenta.',account_changed:'Primero desconectá la cuenta actual para elegir otra cuenta de Google.',failed:'No pudimos completar la conexión. Revisá que Google Calendar esté habilitado y volvé a intentarlo.'};
export function GoogleCalendarSettings({staffMode,result}:{staffMode:boolean;result:string|null}){
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[note,setNote]=useState(result?callbackMessages[result]??'':''),[busy,setBusy]=useState(false),[confirmDisconnect,setConfirmDisconnect]=useState(false);
  useEffect(()=>{
    if(!staffMode)return;let active=true;
    const load=async()=>{try{const value=await api<Status>('/integrations/google-calendar/status');if(active){setStatus(value);setError('');}}catch(e){if(active)setError((e as Error).message);}};
    void load();const timer=setInterval(()=>void load(),10_000);return()=>{active=false;clearInterval(timer);};
  },[staffMode]);
  const act=async(action:'connect'|'sync'|'disconnect')=>{
    setBusy(true);setError('');setNote('');
    try{
      if(action==='connect'){const value=await api<{url:string}>('/integrations/google-calendar/connect',{});window.location.assign(value.url);return;}
      await api(`/integrations/google-calendar/${action}`,{});
      setConfirmDisconnect(false);setNote(action==='sync'?'Sincronización solicitada. Se actualizará en segundo plano.':'Cuenta desconectada. La copia existente queda en Google.');
      setStatus(await api<Status>('/integrations/google-calendar/status'));
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const connected=status?.status==='connected',linked=connected||status?.status==='reauth_required';
  return <section className="preference-group calendar-integration" aria-labelledby="google-calendar-heading">
    <div className="integration-heading"><CalendarDays size={19}/><div><h3 id="google-calendar-heading">Google Calendar</h3><p>Tus turnos en el calendario de tu cuenta.</p></div>{status?.eligible&&<span className={`status-pill ${connected?'green':linked?'amber':''}`}>{connected?'Conectado':linked?'Reconectar':'Sin conectar'}</span>}</div>
    {staffMode&&!status&&!error&&<LoadingPlaceholder variant="list" label="Consultando conexión con Google"/>}
    {(!staffMode||status&&!status.eligible)&&<p className="preference-note">Cada terapeuta conecta su propia cuenta desde sus ajustes. Entrá con un acceso de terapeuta para habilitarla.</p>}
    {status?.eligible&&<>
      <p className="preference-note">Nexo · Turnos incluye paciente, día, hora, profesional y los datos disponibles de su ficha: teléfono, seguro de salud, diagnóstico referido e información adicional. Google administra el correo de nuevos eventos y el recordatorio 30 minutos antes. Activá la sincronización de este calendario y los avisos en tu celular.</p>
      <p className="preference-note">Reservá, cambiá y cancelá desde Nexo. Los eventos personales de Google no bloquean esta agenda.</p>
      {!status.configured&&<p className="preference-note">Falta configurar la conexión de Google en el servidor.</p>}
      {status.email&&<p className="calendar-account">{status.email}</p>}
      {connected&&status.emailNotifications==='permission_required'&&<p className="preference-note" role="status">Tus turnos siguen sincronizándose. Para habilitar el correo de nuevos eventos, reconectá Google y autorizá el permiso de ajustes de calendarios.</p>}
      {connected&&status.emailNotifications==='retry_pending'&&<p className="preference-note" role="status">Los avisos por correo están pendientes de configuración. La sincronización de turnos sigue activa.</p>}
      {linked&&<div className="calendar-sync-status" aria-live="polite"><span>{status.lastSyncedAt?`Última sincronización: ${new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(status.lastSyncedAt))}`:'Esperando primera sincronización'}</span>{Boolean(status.pending)&&<span>{status.pending} {status.pending===1?'turno pendiente':'turnos pendientes'}</span>}{Boolean(status.failed)&&<span className="form-error">{status.failed} {status.failed===1?'turno necesita reintento':'turnos necesitan reintento'}</span>}{status.status==='reauth_required'&&<span>Autorizá Google nuevamente para reanudar la sincronización.</span>}</div>}
      <div className="calendar-connect-actions">
        <button className="secondary-button" disabled={busy||!status.configured} onClick={()=>void act('connect')}><ExternalLink size={15}/>{linked?'Reconectar Google':'Conectar Google Calendar'}</button>
        {connected&&<button className="secondary-button" disabled={busy||!status.configured} onClick={()=>void act('sync')}><RefreshCw size={15}/>Sincronizar ahora</button>}
        {linked&&!confirmDisconnect&&<button className="secondary-button" disabled={busy} onClick={()=>setConfirmDisconnect(true)}><Unplug size={15}/>Desconectar</button>}
      </div>
      {!linked&&status.configured&&<p className="preference-note">Al conectar, autorizás copiar tus próximos turnos. Si Google no permite autorizar en este navegador, abrí Nexo en Chrome o Edge.</p>}
      {confirmDisconnect&&<div className="calendar-disconnect"><p>Se detendrá la sincronización. Los eventos existentes permanecerán en Google y tus turnos se conservarán en Nexo.</p><button className="danger-button" disabled={busy} onClick={()=>void act('disconnect')}>Confirmar desconexión</button><button className="secondary-button" disabled={busy} onClick={()=>setConfirmDisconnect(false)}>Volver</button></div>}
    </>}
    {note&&<p className="preference-note" role="status">{note}</p>}{error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
