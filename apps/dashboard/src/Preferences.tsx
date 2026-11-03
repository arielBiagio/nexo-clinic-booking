import { Bell, CalendarDays, LogOut, Volume2 } from 'lucide-react';
import type { NotificationSettings } from './useNotifications';

export function Preferences({settings,canLogout,onLogout}:{settings:NotificationSettings;canLogout:boolean;onLogout:()=>void}){
  return <div className="preferences-content">
    <p className="preferences-intro">Configurá tus avisos y las conexiones de tu agenda.</p>
    <section className="preference-group">
      <label className="preference-toggle"><Bell size={19}/><span><strong>Notificaciones del navegador</strong><small>Avisar cuando estés en otra pestaña.</small></span><input type="checkbox" checked={settings.notificationsEnabled} disabled={settings.permission==='unsupported'||settings.permission==='denied'} onChange={event=>void settings.setNotifications(event.target.checked)}/></label>
      {settings.permission==='unsupported'&&<p className="preference-note">Este navegador no admite notificaciones para esta página.</p>}
      {settings.permission==='denied'&&<p className="preference-note">Están bloqueadas. Podés permitirlas desde los permisos del sitio en tu navegador.</p>}
    </section>
    <section className="preference-group">
      <label className="preference-toggle"><Volume2 size={19}/><span><strong>Sonido de avisos</strong><small>Un tono suave ante actividad nueva.</small></span><input type="checkbox" checked={settings.soundEnabled} disabled={!settings.soundSupported} onChange={event=>void settings.setSound(event.target.checked)}/></label>
      {!settings.soundSupported?<p className="preference-note">Este navegador no admite el sonido de avisos.</p>:<div className="preference-sound"><button className="secondary-button" onClick={()=>void settings.previewSound()}>Escuchar sonido</button>{settings.soundEnabled&&!settings.soundReady&&<span>Habilitá el audio en esta pestaña con el botón.</span>}</div>}
    </section>
    <section className="preference-group calendar-integration" aria-labelledby="google-calendar-heading">
      <div className="integration-heading"><CalendarDays size={19}/><div><h3 id="google-calendar-heading">Google Calendar</h3><p>Sincronizar los turnos con tu calendario.</p></div><span className="small-tag">Próximamente</span></div>
      <button className="secondary-button" disabled>Conectar Google Calendar</button>
    </section>
    {settings.error&&<p className="form-error" role="status">{settings.error}</p>}
    <p className="preference-note">Se guarda para tu usuario en este navegador. Los avisos funcionan mientras el panel está abierto.</p>
    {canLogout&&<div className="preferences-account"><button className="secondary-button full" onClick={onLogout}><LogOut size={17}/>Cerrar sesión</button></div>}
  </div>;
}
