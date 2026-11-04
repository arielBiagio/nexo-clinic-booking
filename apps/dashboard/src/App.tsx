import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarClock,CalendarCheck2, CalendarDays, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, FlaskConical, Headphones, HeartPulse, Menu, MessageSquare, Moon, Plus, RefreshCw, Search, Settings, Sparkles, Sun, Users, X } from 'lucide-react';
import { api, dateAt, fmtDate, fmtTime, initials } from './api';
import type { Appointment, Chat, Dashboard, StaffUser } from './types';
import { Calendar } from './Calendar';
import { Dialog } from './Dialog';
import { Booking } from './Booking';
import { Simulator } from './Simulator';
import { Inbox } from './Inbox';
import { Schedule } from './Schedule';
import { PatientCard } from './PatientCard';
import { Staff, TeamDirectory } from './Staff';
import { TherapistProfile } from './TherapistProfile';
import {RemoveAction,RemovedItems,type RemovedKind} from './RemovalControls';
import { useInboxAlerts } from './useInboxAlerts';
import { ActivityBell } from './ActivityBell';
import { useNotifications } from './useNotifications';
import { Preferences } from './Preferences';
import { QuickActions } from './QuickActions';
import { useTheme } from './useTheme';
import { matchesAgendaSearch } from './agendaSearch';
import { LoadingPlaceholder } from './LoadingPlaceholder';
import { CancelWeek } from './CancelWeek';

type Page='agenda'|'inbox'|'schedule'|'team'|'profile';
export function App({user,accessMode,onLogout,onUserChanged}:{user:StaffUser;accessMode:'demo'|'staff';onLogout:()=>void;onUserChanged?:()=>void}) {
  const isTherapist=user.role==='therapist',canManageStaff=accessMode==='staff'&&user.role==='admin';
  const roleName={admin:'Administrador',reception:'Recepción',therapist:'Terapeuta'}[user.role];
  const pageFromHash=():Page=>{const value=window.location.hash.slice(1);return value==='schedule'?'schedule':!isTherapist&&value==='inbox'?'inbox':isTherapist&&value==='profile'?'profile':value==='team'?'team':'agenda';};
  const [data,setData]=useState<Dashboard|null>(null),[page,setPage]=useState<Page>(pageFromHash),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const notifications=useNotifications(user.id);
  const appearance=useTheme();
  const {theme,toggleTheme}=appearance;
  const [teamCreateRequest,setTeamCreateRequest]=useState(0);
  const [filter,setFilter]=useState('all'),[search,setSearch]=useState(''),[toast,setToast]=useState(''),[mobileMenu,setMobileMenu]=useState(false);
  const [booking,setBooking]=useState<{date?:string;therapistId?:string;slotId?:string;editing?:Appointment}|null>(null),[appointment,setAppointment]=useState<Appointment|null>(null),[help,setHelp]=useState(false);
  const [simulator,setSimulator]=useState(false),[chat,setChat]=useState<Chat|null>(null),[selectedConversation,setSelectedConversation]=useState<string|null>(null);
  const [removedKind,setRemovedKind]=useState<RemovedKind|null>(null),[undo,setUndo]=useState<{kind:RemovedKind;id:string}|null>(null),[restoring,setRestoring]=useState(false);
  const alerts=useInboxAlerts(!isTherapist,{agenda:'Agenda',inbox:'Conversaciones',schedule:'Disponibilidad',team:'Equipo',profile:'Mi perfil'}[page],setToast,notifications.onAttention);
  const load=useCallback(async(week?:string)=>{
    setLoading(true);setError('');
    try{setData(await api<Dashboard>(`/dashboard${week?`?fromDate=${week}`:''}`));}
    catch(e){setError((e as Error).message);}finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const update=()=>setPage(pageFromHash());window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(timer);},[toast]);
  const week=data?.weekStart;
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)void load(week);},15_000);return()=>clearInterval(timer);},[load,week]);
  const refresh=()=>{void load(data?.weekStart);};
  const remove=async(kind:RemovedKind,id:string)=>{
    await api(kind==='appointments'?`/appointments/${id}`:`/demo/conversations/${id}`,undefined,'DELETE');
    setUndo({kind,id});
    if(kind==='appointments')setAppointment(null);
    else{
      if(sessionStorage.getItem('nexo-demo-chat')===id)sessionStorage.removeItem('nexo-demo-chat');
      if(chat?.id===id)setChat(null);
      if(selectedConversation===id)setSelectedConversation(null);
    }
    setToast(kind==='appointments'?'Turno quitado. El horario vuelve a estar libre.':'Conversación eliminada de la bandeja. Podés recuperarla.');
    await load(data?.weekStart);
  };
  const restore=async(kind:RemovedKind,id:string)=>{
    await api(kind==='appointments'?`/appointments/${id}/restore`:`/demo/conversations/${id}/restore`,{},'POST');
    if(undo?.id===id)setUndo(null);
    if(kind==='conversations')setSelectedConversation(id);
    setToast(kind==='appointments'?'Turno restaurado.':'Conversación restaurada.');await load(data?.weekStart);
  };
  const undoLast=async()=>{if(!undo||restoring)return;setRestoring(true);try{await restore(undo.kind,undo.id);}catch(e){setToast((e as Error).message);}finally{setRestoring(false);}};
  const navigate=(target:Page)=>{setPage(target);window.location.hash=target;setMobileMenu(false);setSearch('');};
  const startSimulator=async()=>{if(isTherapist)return;setMobileMenu(false);setSimulator(true);try{
    const remembered=chat?.id??sessionStorage.getItem('nexo-demo-chat');
    let next:Chat;
    try{next=remembered?await api<Chat>(`/demo/conversations/${remembered}`):await api<Chat>('/demo/conversations',{});}
    catch{sessionStorage.removeItem('nexo-demo-chat');next=await api<Chat>('/demo/conversations',{});}
    sessionStorage.setItem('nexo-demo-chat',next.id);setChat(next);refresh();
  }catch(e){setToast((e as Error).message);}};
  const openInbox=(id?:string)=>{if(isTherapist)return;setSimulator(false);setAppointment(null);if(id)setSelectedConversation(id);navigate('inbox');refresh();};
  const pending=data?.conversations.filter(c=>c.handoff_id||c.status==='human_led')??[];
  const filteredAppointments=data?.appointments.filter(a=>(filter==='all'||a.therapist_id===filter)&&matchesAgendaSearch(search,a.patient_name,a.therapist_name))??[];
  const zone=data?.clinic.time_zone??'America/New_York';
  const next=filteredAppointments.filter(a=>Date.parse(a.starts_at)>Date.now()).slice(0,3);
  const professionals=data?.professionals??data?.therapists??[];
  const pageTitles:Record<Page,string>={agenda:'Agenda',inbox:'Conversaciones',schedule:'Disponibilidad',team:'Equipo',profile:'Mi perfil'};
  return <div className={`workspace ${page==='inbox'?'workspace-inbox':''} ${isTherapist?'workspace-readonly':''}`}>
    {mobileMenu&&<button className="sidebar-scrim" aria-label="Cerrar navegación" onClick={()=>setMobileMenu(false)}/>}
    <aside className={`sidebar ${mobileMenu?'mobile-open':''}`}>
      <a href="#agenda" className="brand" onClick={e=>{e.preventDefault();navigate('agenda');}} aria-label="Nexo, ir a la agenda"><span className="brand-mark"><span/><span/><span/></span><span>nexo<span className="brand-dot">.</span></span></a>
      <div className="clinic-switch"><span className="clinic-icon"><HeartPulse size={19}/></span><div><strong>Clínica Demo</strong><span>Espacio de trabajo</span></div><ChevronDown size={14}/></div>
      <div className="sidebar-navigation"><div className="nav-label">TU CLÍNICA</div>
      <nav aria-label="Navegación principal"><button className={page==='agenda'?'active':''} onClick={()=>navigate('agenda')}><CalendarDays size={19}/>Agenda</button>{!isTherapist&&<><button className={page==='inbox'?'active':''} onClick={()=>{setSelectedConversation(null);navigate('inbox');}}><MessageSquare size={19}/>Conversaciones{alerts.total>0&&<span className="nav-badge" aria-label={`${alerts.total} conversaciones por atender`}>{alerts.total}</span>}</button></>}<button className={page==='schedule'?'active':''} onClick={()=>navigate('schedule')}><Clock3 size={19}/>Disponibilidad</button>{isTherapist&&<button className={page==='profile'?'active':''} onClick={()=>navigate('profile')}><Users size={19}/>Mi perfil</button>}<button className={page==='team'?'active':''} onClick={()=>navigate('team')}><Users size={19}/>Equipo</button></nav>{!isTherapist&&<button className="sidebar-simulator" onClick={()=>void startSimulator()}><Sparkles size={18}/>Probar asistente</button>}</div>
      <div className="sidebar-bottom"><div className="sidebar-user"><span className="user-avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><span>{roleName}{accessMode==='demo'?' · Demo':''}</span></div><button className="icon-button settings-button" aria-label="Abrir ajustes" title="Ajustes" onClick={()=>{setMobileMenu(false);setSettingsOpen(true);}}><Settings size={19}/></button></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><nav className="breadcrumbs" aria-label="Ubicación"><button className="icon-button mobile-nav" aria-label="Abrir menú" onClick={()=>setMobileMenu(true)}><Menu size={21}/></button><span>Clínica Demo</span><ChevronRight size={13}/><strong aria-current="page">{pageTitles[page]}</strong></nav><div className="topbar-actions"><span className="demo-pill"><i/>{accessMode==='staff'?'Equipo · acceso privado':'Demo · datos ficticios'}</span>{!isTherapist&&<button className="icon-button" aria-label="Ayuda de la demo" onClick={()=>setHelp(true)}><CircleHelp size={18}/></button>}<span className="topbar-divider"/><button className="icon-button theme-toggle" aria-label={theme==='dark'?'Activar modo claro':'Activar modo oscuro'} title={theme==='dark'?'Modo claro':'Modo oscuro'} aria-pressed={theme==='dark'} onClick={toggleTheme}>{theme==='dark'?<Sun size={19}/>:<Moon size={19}/>}</button><ActivityBell zone={zone} onNewActivity={notifications.onActivity}/><span className="user-avatar small">{initials(user.name)}</span></div></header>
      <main data-page={page} className={page==='inbox'?'inbox-main':undefined}>
        <h1 className="sr-only">{pageTitles[page]}</h1>
        {error&&<div className="load-error" role="alert"><span>{error}</span><button className="secondary-button" onClick={refresh}>Reintentar</button></div>}
        {!data&&!error&&<LoadingPlaceholder variant={page==='agenda'?'dashboard':page==='inbox'?'inbox':page==='schedule'?'schedule':'form'} label="Cargando sección"/>}
        {data&&<>
          {page==='agenda'&&<><div className="stats-grid"><div className="stat-card"><span className="stat-icon mint"><CalendarCheck2 size={19}/></span><span className="stat-label">Turnos esta semana</span><div><strong>{data.appointments.length}</strong><span className="stat-tag"><Check size={12}/>Confirmados</span></div></div><div className="stat-card"><span className="stat-icon lavender"><Clock3 size={19}/></span><span className="stat-label">Horarios disponibles</span><div><strong>{data.slots.length}</strong><span className="stat-description">para reservar</span></div></div><button disabled={isTherapist} className="stat-card stat-button" onClick={()=>openInbox()}><span className="stat-icon peach"><Headphones size={19}/></span><span className="stat-label">Necesitan una mano</span><div><strong>{pending.length}</strong><span className={`stat-tag ${pending.length?'warm':''}`}>{pending.length?'En recepción':'Todo al día'}<ArrowUpRight size={12}/></span></div></button><button className="stat-card stat-button" onClick={()=>navigate('team')} aria-label={canManageStaff?'Ver equipo y profesionales':'Ver profesionales'}><span className="stat-icon blue"><Users size={19}/></span><span className="stat-label">Profesionales</span><div><strong>{professionals.length}</strong><span className="avatar-stack">{professionals.map((t,i)=><i key={t.id} className={`doctor-${i}`}>{initials(t.name)}</i>)}</span></div></button></div>
          <div className="agenda-section-heading"><div><h2>Agenda semanal<span className="small-tag">{fmtDate(data.weekStart,{month:'long',year:'numeric'})}</span></h2></div><div className="agenda-search"><Search size={15}/><input type="search" maxLength={120} autoComplete="off" aria-label="Buscar paciente o profesional" placeholder="Buscar paciente o profesional…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="icon-button" aria-label="Limpiar búsqueda" onClick={()=>setSearch('')}><X size={15}/></button>}<button className={`icon-button ${loading?'spinning':''}`} aria-label="Actualizar agenda" onClick={refresh}><RefreshCw size={15}/></button></div></div>
          <div className="agenda-layout"><Calendar data={data} onWeek={date=>void load(date)} onBook={(date,therapistId,slotId)=>setBooking({date,therapistId,slotId})} onAppointment={setAppointment} filter={filter} onFilter={setFilter} search={search}/>
            <aside className="agenda-rail"><section className="panel upcoming-panel"><div className="rail-heading"><h2>Próximos encuentros</h2><span className="live-dot"/></div>{next.length?next.map(a=><button className="upcoming-item" key={a.id} onClick={()=>setAppointment(a)}><span className={`patient-avatar doctor-${data.therapists.findIndex(t=>t.id===a.therapist_id)}`}>{initials(a.patient_name)}</span><div><strong>{a.patient_name}</strong><span>{a.therapist_name}</span><small>{fmtDate(dateAt(a.starts_at,zone),{weekday:'short',day:'numeric',month:'short'})} · {fmtTime(a.starts_at,zone)}</small></div><ChevronRight size={14}/></button>):<div className="empty-upcoming"><CalendarDays size={25}/><p>No hay turnos con estos filtros.</p></div>}{<button className="rail-link" onClick={()=>setBooking({})}>Agregar un turno<Plus size={14}/></button>}</section>
            {!isTherapist&&<section className="handoff-card"><div className="handoff-card-top"><span><Headphones size={20}/></span><span className="small-tag">RECEPCIÓN</span></div><h3>{pending.length?'Por atender':'Sin pendientes'}</h3>{pending.length>0&&<p>{pending.length} {pending.length===1?'conversación pendiente':'conversaciones pendientes'}.</p>}{pending.length>0&&<div className="pending-patient"><span className="patient-avatar">{initials(pending[0]!.patient_name)}</span><div><strong>{pending[0]!.patient_name}</strong><span>Solicitó hablar con recepción</span></div></div>}<button onClick={()=>openInbox(pending[0]?.id)}>Ir a la bandeja<ArrowRight size={16}/></button></section>}

            </aside></div>
          {<div className="cleanup-toolbar"><button className="removed-link" onClick={()=>setRemovedKind('appointments')}>Ver turnos quitados</button></div>}</>}
          {page==='inbox'&&<Inbox unread={alerts.unread} onRead={alerts.refresh} data={data} selected={selectedConversation} onSelect={setSelectedConversation} onRefresh={refresh} notify={setToast} onDelete={id=>remove('conversations',id)} onRemoved={()=>setRemovedKind('conversations')}/>}
          {page==='schedule'&&<Schedule data={data} onRefresh={refresh} notify={setToast}/>}
          {page==='team'&&(canManageStaff?<Staff focusCreate={teamCreateRequest} therapists={data.therapists} professionals={professionals} notify={setToast} onRefresh={refresh}/>:<TeamDirectory professionals={professionals}/>)}
          {page==='profile'&&isTherapist&&user.therapistId&&<TherapistProfile therapistId={user.therapistId} notify={setToast} onSaved={()=>{refresh();onUserChanged?.();}}/>}
        </>}
      </main>
    </div>
    {page!=='inbox'&&!booking&&!appointment&&!simulator&&!settingsOpen&&!help&&!removedKind&&!mobileMenu&&<QuickActions canManageStaff={canManageStaff} onBook={()=>setBooking({})} onTeam={()=>{navigate('team');setTeamCreateRequest(value=>value+1);}}/>}
    {settingsOpen&&<Dialog title="Ajustes" onClose={()=>setSettingsOpen(false)}><Preferences appearance={appearance} settings={notifications} canLogout={accessMode==='staff'} onLogout={()=>{setSettingsOpen(false);onLogout();}}/></Dialog>}
    {booking&&data&&<Dialog title={booking.editing?'Reprogramar turno':'Nuevo turno'} onClose={()=>setBooking(null)}><Booking {...(booking.editing?{editing:booking.editing}:{})} ownTherapistId={isTherapist?user.therapistId??undefined:undefined} data={data} initialDate={booking.date} initialTherapist={booking.therapistId} initialSlot={booking.slotId} onDone={()=>{setBooking(null);refresh();}} notify={setToast}/></Dialog>}
    {appointment&&data&&<Dialog title="Detalle del turno" onClose={()=>setAppointment(null)}><div className="appointment-detail"><span className="status-pill green"><CheckCheck size={14}/>Confirmado</span><span className="detail-patient-avatar">{initials(appointment.patient_name)}</span><h3>{appointment.patient_name}</h3><p>Paciente ficticio · Clínica Demo</p><div className="detail-info"><span><CalendarDays size={17}/>{fmtDate(dateAt(appointment.starts_at,zone),{weekday:'long',day:'numeric',month:'long'})}</span><span><Clock3 size={17}/>{fmtTime(appointment.starts_at,zone)} – {fmtTime(appointment.ends_at,zone)}</span><span><Users size={17}/>{appointment.therapist_name}</span></div><PatientCard readOnly={isTherapist} conversationId={appointment.conversation_id} onSaved={refresh}/>{!isTherapist&&<button className="secondary-button full" onClick={()=>openInbox(appointment.conversation_id)}><MessageSquare size={16}/>Ver conversación</button>}<button className="primary-button full" disabled={Date.parse(appointment.starts_at)<=Date.now()} onClick={()=>{setBooking({date:dateAt(appointment.starts_at,zone),therapistId:appointment.therapist_id,editing:appointment});setAppointment(null);}}><CalendarClock size={16}/>Reprogramar turno</button><RemoveAction label="Quitar turno de la agenda" description="Libera el horario y conserva la ficha del paciente. Podés deshacerlo si sigue disponible." onRemove={()=>remove('appointments',appointment.id)}/>{Date.parse(appointment.starts_at)>Date.now()&&<CancelWeek key={appointment.id} appointmentId={appointment.id} ownAgenda={isTherapist} onCancelled={count=>{setAppointment(null);setToast(`${count} ${count===1?'turno cancelado':'turnos cancelados'}`);refresh();}}/>}</div></Dialog>}
    {simulator&&<Dialog title="Simulador de paciente" onClose={()=>setSimulator(false)} drawer><Simulator chat={chat} setChat={setChat} onChange={refresh} onInbox={openInbox} onDelete={id=>remove('conversations',id)}/></Dialog>}
    {help&&<Dialog title="Tu primera vuelta por Nexo" onClose={()=>setHelp(false)}><div className="help-content"><div className="help-hero"><Sparkles size={26}/><h3>Probá cómo se conecta todo.</h3><p>Esta demo usa pacientes ficticios. No se envían emails ni mensajes a pacientes reales. El chat indica si OpenRouter procesa tus mensajes.</p></div><ol><li><span>1</span><div><strong>Reservá desde la agenda</strong><p>Hacé clic en «Nuevo turno», elegí un profesional y confirmá un horario.</p></div></li><li><span>2</span><div><strong>Ponete del lado del paciente</strong><p>El simulador te guía para elegir un turno. La reserva aparecerá en tu agenda.</p></div></li><li><span>3</span><div><strong>Pedí ayuda a recepción</strong><p>Solicitá hablar con una persona y respondé desde Conversaciones.</p></div></li><li><span>4</span><div><strong>Acomodá los horarios</strong><p>En Disponibilidad podés cambiar jornadas, descansos y bloquear una fecha.</p></div></li></ol><p className="privacy-note">{accessMode==='staff'?'La ficha y los turnos se guardan en el entorno compartido de la clínica.':'La ficha y el resumen se guardan en esta computadora.'} Los mensajes y el contexto del chat también quedan guardados.</p><button className="primary-button full" onClick={()=>{setHelp(false);void startSimulator();}}>Empezar mi prueba<ArrowRight size={16}/></button></div></Dialog>}
    {removedKind&&<Dialog title={removedKind==='appointments'?'Turnos quitados':'Conversaciones eliminadas'} onClose={()=>setRemovedKind(null)}><RemovedItems kind={removedKind} zone={zone} onRestore={restore}/></Dialog>}
    {undo&&<div className="undo-note" role="status"><span>{undo.kind==='appointments'?'Turno quitado':'Conversación eliminada'}</span><button onClick={()=>void undoLast()} disabled={restoring}>{restoring?'Restaurando…':'Deshacer'}</button><button className="icon-button" aria-label="Cerrar opción de deshacer" onClick={()=>setUndo(null)}><X size={15}/></button></div>}
    {toast&&<div className="toast" role="status"><span><Check size={16}/></span>{toast}<button aria-label="Cerrar notificación" onClick={()=>setToast('')}><X size={15}/></button></div>}
  </div>;
}
