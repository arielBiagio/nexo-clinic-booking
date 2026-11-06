import { t, useLanguage, getLocale } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { api } from './api';
import { LoadingPlaceholder } from './LoadingPlaceholder';
import type { CalendarFocus } from './types';

type Movement={id:string;appointment_id:string;kind:CalendarFocus['kind'];occurred_at:string;starts_at:string|null;previous_starts_at:string|null;therapist_id:string|null;navigation_starts_at?:string;navigation_therapist_id?:string|null;patient_name:string;therapist_name:string|null;previous_therapist_name:string|null;unread:boolean};
type Feed={items:Movement[];unreadCount:number};
const labels={booked:'Nuevo turno',rescheduled:'Turno reprogramado',cancelled:'Turno cancelado',restored:'Turno restaurado'};

export function ActivityBell({zone,onNewActivity,onSelect}:{zone:string;onNewActivity:()=>void;onSelect:(target:Omit<CalendarFocus,'requestId'|'showWeek'>)=>void}){
  useLanguage();
  const [open,setOpen]=useState(false),[feed,setFeed]=useState<Feed>({items:[],unreadCount:0}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [visibleCount,setVisibleCount]=useState(6);
  const [loading,setLoading]=useState(true);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),request=useRef(0),alive=useRef(true),reading=useRef(false);
  const seen=useRef<Set<string>|null>(null),alertRef=useRef(onNewActivity);alertRef.current=onNewActivity;
  const refresh=useCallback(async()=>{
    const token=++request.current;
    try{const next=await api<Feed>('/activity');if(alive.current&&token===request.current){
      if(seen.current!==null&&next.items.some(item=>item.unread&&!seen.current!.has(item.id)))alertRef.current();
      seen.current=new Set(next.items.map(item=>item.id));setFeed(next);setError('');
    }}
    catch{if(alive.current&&token===request.current)setError(t("No pudimos cargar la actividad."));}
    finally{if(alive.current&&token===request.current)setLoading(false);}
  },[]);
  useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),10_000);window.addEventListener('focus',refresh);return()=>{alive.current=false;request.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};},[refresh]);
  const markRead=useCallback(async(ids:string[]|null)=>{
    if(reading.current)return;reading.current=true;setBusy(true);
    try{await api('/activity/read',ids?{ids}:{all:true});if(alive.current)await refresh();}
    catch{if(alive.current)setError(t("No pudimos marcar la actividad como leída."));}
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
  const when=(value:string)=>new Intl.DateTimeFormat(getLocale(),{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return <div className="activity-bell" ref={root}>
    <button ref={trigger} className="icon-button activity-trigger" aria-label={t("Actividad de turnos{0}", [feed.unreadCount?t(", {0} sin leer", [feed.unreadCount]):''])} aria-expanded={open} aria-controls="appointment-activity" onClick={()=>{setOpen(!open);if(!open){setVisibleCount(6);void refresh();}}}><Bell size={19}/>{feed.unreadCount>0&&<span className="activity-badge">{feed.unreadCount>99?'99+':feed.unreadCount}</span>}</button>
    {open&&<section id="appointment-activity" className="activity-popover" aria-label={t("Actividad de turnos")}>
      <div className="activity-heading"><h2>{t("Actividad")}</h2><button className="icon-button" aria-label={t("Cerrar actividad")} onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={18}/></button></div>
      <div className="activity-tools"><span>{t("Últimos movimientos")}</span>{feed.unreadCount>0&&<button disabled={busy} onClick={()=>void markRead(null)}>{t("Marcar todo leído")}</button>}</div>
      {error&&<div className="activity-error" role="status">{t(error)} <button onClick={()=>void refresh()}>{t("Reintentar")}</button></div>}
      <ul className="activity-list">{feed.items.slice(0,visibleCount).map(item=>{
        const startsAt=item.starts_at??item.navigation_starts_at??item.previous_starts_at;
        return <li key={item.id} className={`activity-${item.kind}${item.unread?' activity-unread':''}`}><button type="button" className="activity-item" disabled={!startsAt} aria-label={t("Ver en la agenda: {0} · {1}{2}", [t(labels[item.kind]), item.patient_name, startsAt?` · ${when(startsAt)}`:''])} onClick={()=>{if(!startsAt)return;setOpen(false);onSelect({appointmentId:item.appointment_id,startsAt,therapistId:item.therapist_id??item.navigation_therapist_id??null,kind:item.kind});}}><strong>{t(labels[item.kind])}</strong><span>{item.patient_name}</span>{item.starts_at&&<span>{when(item.starts_at)}{item.therapist_name?` · ${item.therapist_name}`:''}</span>}{item.previous_starts_at&&<small>{t("Antes:")}{' '}{when(item.previous_starts_at)}{item.previous_therapist_name?` · ${item.previous_therapist_name}`:''}</small>}<time dateTime={item.occurred_at}>{when(item.occurred_at)}</time></button></li>;
      })}</ul>
      {feed.items.length>6&&<div className="activity-expand">{visibleCount<feed.items.length&&<button onClick={()=>setVisibleCount(count=>count+6)}>{t("Ver más")}</button>}{visibleCount>6&&<button onClick={()=>{setVisibleCount(6);root.current?.querySelector('.activity-list')?.scrollTo({top:0});}}>{t("Ver menos")}</button>}</div>}
      {loading&&<LoadingPlaceholder variant="list" label={t("Cargando actividad")}/>}
      {!loading&&!feed.items.length&&!error&&<p className="activity-empty">{t("Todavía no hay movimientos.")}</p>}
    </section>}
  </div>;
}
