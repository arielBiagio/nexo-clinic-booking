import { useEffect,useState } from 'react';
import { CalendarDays,Link2,RefreshCw,Unplug } from 'lucide-react';
import { api } from './api';
import { LoadingPlaceholder } from './LoadingPlaceholder';

type Status={eligible:boolean;configured:boolean;status?:'connected'|'reauth_required'|'disconnected';email?:string;gmailEnabled?:boolean;gmailError?:string|null;gmailLastSentAt?:string|null;gmailPending?:number;gmailFailed?:number;gmailUnknown?:number;lastSyncedAt?:string|null;pending?:number;failed?:number;error?:string|null};
const mailErrors:Record<string,string>={GMAIL_API_DISABLED:'Falta habilitar Gmail API en el proyecto de Google Cloud. Después, tocá Sincronizar ahora para reintentar.',GMAIL_PERMISSION:'Reconectá Google y autorizá el envío de correo.',GOOGLE_RECONNECT:'Reconectá Google para renovar el permiso de envío.',GOOGLE_AUTH_FAILED:'No se pudo renovar el acceso de Gmail. Reconectá Google.'};
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
      {!status.configured&&<p className="preference-note">Falta configurar la conexión de Google en el servidor.</p>}
      {status.email&&<p className="calendar-account">{status.email}</p>}
      {linked&&<div className="calendar-sync-status" aria-live="polite">
        <strong>Avisos por Gmail</strong>
        {!status.gmailEnabled&&<span>Falta autorizar el envío: habilitá Gmail API en Google Cloud y tocá Reconectar Google. La copia de turnos sigue siendo independiente.</span>}
        {status.gmailError&&<span className="form-error">{mailErrors[status.gmailError]??'El envío de correo necesita un reintento. La copia de turnos no se detiene.'}</span>}
        {Boolean(status.gmailPending)&&<span>{status.gmailPending} {status.gmailPending===1?'aviso pendiente':'avisos pendientes'}</span>}
        {Boolean(status.gmailFailed)&&<span className="form-error">{status.gmailFailed} {status.gmailFailed===1?'aviso rechazado':'avisos rechazados'}. Tocá Sincronizar ahora para reintentar.</span>}
        {Boolean(status.gmailUnknown)&&<span className="form-error">No se pudo confirmar el envío de {status.gmailUnknown} {status.gmailUnknown===1?'aviso':'avisos'}. Revisá Recibidos y Enviados; no se reenvían automáticamente para evitar duplicados.</span>}
        {status.gmailLastSentAt&&<span>Último envío aceptado por Gmail: {new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(status.gmailLastSentAt))}</span>}
      </div>}
      {linked&&<div className="calendar-sync-status" aria-live="polite"><span>{status.lastSyncedAt?`Última sincronización: ${new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(status.lastSyncedAt))}`:'Esperando primera sincronización'}</span>{Boolean(status.pending)&&<span>{status.pending} {status.pending===1?'turno pendiente':'turnos pendientes'}</span>}{Boolean(status.failed)&&<span className="form-error">{status.failed} {status.failed===1?'turno necesita reintento':'turnos necesitan reintento'}</span>}{status.status==='reauth_required'&&<span>Autorizá Google nuevamente para reanudar la sincronización.</span>}</div>}
      <div className="calendar-connect-actions">
        {connected&&<button className="settings-action settings-action-main" disabled={busy||!status.configured} onClick={()=>void act('sync')}><span className="settings-action-icon"><RefreshCw size={18}/></span><span>Sincronizar ahora</span></button>}
        <button className={`settings-action ${linked?'':'settings-action-main'}`} disabled={busy||!status.configured} onClick={()=>void act('connect')}><span className="settings-action-icon"><Link2 size={18}/></span><span>{linked?'Reconectar Google':'Conectar Google'}</span></button>
        {linked&&!confirmDisconnect&&<button className="settings-action settings-action-danger" disabled={busy} onClick={()=>setConfirmDisconnect(true)}><span className="settings-action-icon"><Unplug size={18}/></span><span>Desconectar</span></button>}
      </div>
      {!linked&&status.configured&&<p className="preference-note">Al conectar, autorizás copiar tus próximos turnos y enviar avisos de reservas nuevas desde tu Gmail hacia tu misma dirección. Para el correo debe estar habilitada Gmail API en Google Cloud. Si Google no permite autorizar en este navegador, abrí Nexo en Chrome o Edge.</p>}
      {confirmDisconnect&&<div className="calendar-disconnect"><p>Se detendrá la sincronización. Los eventos existentes permanecerán en Google y tus turnos se conservarán en Nexo.</p><button className="settings-action settings-action-danger" disabled={busy} onClick={()=>void act('disconnect')}>Sí, desconectar</button><button className="settings-action" disabled={busy} onClick={()=>setConfirmDisconnect(false)}>Volver</button></div>}
    </>}
    {note&&<p className="preference-note" role="status">{note}</p>}{error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
