import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { api } from './api';

type Movement={id:string;kind:'booked'|'rescheduled'|'cancelled'|'restored';occurred_at:string;starts_at:string|null;previous_starts_at:string|null;patient_name:string;therapist_name:string|null;previous_therapist_name:string|null;unread:boolean};
type Feed={items:Movement[];unreadCount:number};
const labels={booked:'Nuevo turno',rescheduled:'Turno reprogramado',cancelled:'Turno cancelado',restored:'Turno restaurado'};

export function ActivityBell({zone,canNotify,permission,onRequestPermission}:{zone:string;canNotify:boolean;permission:NotificationPermission|'unsupported';onRequestPermission:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[feed,setFeed]=useState<Feed>({items:[],unreadCount:0}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [visibleCount,setVisibleCount]=useState(6);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),request=useRef(0),alive=useRef(true),reading=useRef(false);
  const refresh=useCallback(async()=>{
    const token=++request.current;
    try{const next=await api<Feed>('/activity');if(alive.current&&token===request.current){setFeed(next);setError('');}}
    catch{if(alive.current&&token===request.current)setError('No pudimos cargar la actividad.');}
  },[]);
  useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),10_000);window.addEventListener('focus',refresh);return()=>{alive.current=false;request.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};},[refresh]);
  const markRead=useCallback(async(ids:string[]|null)=>{
    if(reading.current)return;reading.current=true;setBusy(true);
    try{await api('/activity/read',ids?{ids}:{all:true});if(alive.current)await refresh();}
    catch{if(alive.current)setError('No pudimos marcar la actividad como leída.');}
    finally{reading.current=false;if(alive.current)setBusy(false);}
  },[refresh]);
  useEffect(()=>{
    if(!open)return;
    const markVisible=()=>{const ids=feed.items.slice(0,visibleCount).filter(item=>item.unread).map(item=>item.id);if(ids.length&&!document.hidden&&document.hasFocus())void markRead(ids);};
    // Read only the entries the user actually opened, never the whole unseen history.
    markVisible();window.addEventListener('focus',markVisible);document.addEventListener('visibilitychange',markVisible);
    return()=>{window.removeEventListener('focus',markVisible);document.removeEventListener('visibilitychange',markVisible);};
  },[open,feed,visibleCount,markRead]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  const when=(value:string)=>new Intl.DateTimeFormat('es-AR',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return <div className="activity-bell" ref={root}>
    <button ref={trigger} className="icon-button activity-trigger" aria-label={`Actividad de turnos${feed.unreadCount?`, ${feed.unreadCount} sin leer`:''}`} aria-expanded={open} aria-controls="appointment-activity" onClick={()=>{setOpen(!open);if(!open){setVisibleCount(6);void refresh();}}}><Bell size={19}/>{feed.unreadCount>0&&<span className="activity-badge">{feed.unreadCount>99?'99+':feed.unreadCount}</span>}</button>
    {open&&<section id="appointment-activity" className="activity-popover" aria-label="Actividad de turnos">
      <div className="activity-heading"><h2>Actividad</h2><button className="icon-button" aria-label="Cerrar actividad" onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={18}/></button></div>
      <div className="activity-tools"><span>Últimos movimientos</span>{feed.unreadCount>0&&<button disabled={busy} onClick={()=>void markRead(null)}>Marcar todo leído</button>}</div>
      {error&&<div className="activity-error" role="status">{error} <button onClick={()=>void refresh()}>Reintentar</button></div>}
      <ul className="activity-list">{feed.items.slice(0,visibleCount).map(item=><li key={item.id} className={`activity-${item.kind}${item.unread?' activity-unread':''}`}><strong>{labels[item.kind]}</strong><span>{item.patient_name}</span>{item.starts_at&&<span>{when(item.starts_at)}{item.therapist_name?` · ${item.therapist_name}`:''}</span>}{item.previous_starts_at&&<small>Antes: {when(item.previous_starts_at)}{item.previous_therapist_name?` · ${item.previous_therapist_name}`:''}</small>}<time dateTime={item.occurred_at}>{when(item.occurred_at)}</time></li>)}</ul>
      {feed.items.length>6&&<div className="activity-expand">{visibleCount<feed.items.length&&<button onClick={()=>setVisibleCount(count=>count+6)}>Ver más</button>}{visibleCount>6&&<button onClick={()=>{setVisibleCount(6);root.current?.querySelector('.activity-list')?.scrollTo({top:0});}}>Ver menos</button>}</div>}
      {!feed.items.length&&!error&&<p className="activity-empty">Todavía no hay movimientos.</p>}
      {canNotify&&permission!=='unsupported'&&permission!=='granted'&&<div className="activity-footer">{permission==='default'?<button onClick={()=>void onRequestPermission()}>Activar avisos de atención humana</button>:<span>Avisos bloqueados en el navegador</span>}</div>}
    </section>}
  </div>;
}
