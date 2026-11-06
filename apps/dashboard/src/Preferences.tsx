import { t, useLanguage } from './i18n';
import { Bell, LogOut, Volume2 } from 'lucide-react';
import type { NotificationSettings } from './useNotifications';
import type { AppearanceSettings } from './useTheme';
import { AppearancePicker } from './AppearancePicker';
import { GoogleCalendarSettings } from './GoogleCalendarSettings';

export function Preferences({settings,appearance,canLogout,onLogout,calendarResult}:{settings:NotificationSettings;appearance:AppearanceSettings;canLogout:boolean;onLogout:()=>void;calendarResult:string|null}){
  useLanguage();
  return <div className="preferences-content">
    <p className="preferences-intro">{t("Configurá tus avisos y las conexiones de tu agenda.")}</p>
    <AppearancePicker appearance={appearance}/>
    <section className="preference-group">
      <label className="preference-toggle"><Bell size={19}/><span><strong>{t("Notificaciones del navegador")}</strong><small>{t("Avisar cuando estés en otra pestaña.")}</small></span><input type="checkbox" checked={settings.notificationsEnabled} disabled={settings.permission==='unsupported'||settings.permission==='denied'} onChange={event=>void settings.setNotifications(event.target.checked)}/></label>
      {settings.permission==='unsupported'&&<p className="preference-note">{t("Este navegador no admite notificaciones para esta página.")}</p>}
      {settings.permission==='denied'&&<p className="preference-note">{t("Están bloqueadas. Podés permitirlas desde los permisos del sitio en tu navegador.")}</p>}
    </section>
    <section className="preference-group">
      <label className="preference-toggle"><Volume2 size={19}/><span><strong>{t("Sonido de avisos")}</strong><small>{t("Un aviso breve ante actividad nueva.")}</small></span><input type="checkbox" checked={settings.soundEnabled} disabled={!settings.soundSupported} onChange={event=>void settings.setSound(event.target.checked)}/></label>
      {!settings.soundSupported&&<p className="preference-note">{t("Este navegador no admite el sonido de avisos.")}</p>}
      {settings.soundSupported&&settings.soundEnabled&&!settings.soundReady&&<p className="preference-note">{t("Interactuá con el panel para habilitar el audio en esta pestaña.")}</p>}
    </section>
    <GoogleCalendarSettings staffMode={canLogout} result={calendarResult}/>
    {settings.error&&<p className="form-error" role="status">{t(settings.error)}</p>}
    {canLogout&&<div className="preferences-account"><button className="settings-action settings-logout" onClick={onLogout}><span className="settings-action-icon"><LogOut size={18}/></span><span>{t("Cerrar sesión")}</span></button></div>}
  </div>;
}
