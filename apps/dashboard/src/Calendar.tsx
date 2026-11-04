import { useEffect,useRef,useState } from 'react';
import { ChevronLeft, ChevronRight, SlidersHorizontal, Plus, CalendarDays } from 'lucide-react';
import type { Appointment,CalendarFocus, Dashboard } from './types';
import { addDays, dateAt, fmtDate, fmtTime, minutesAt } from './api';
import { matchesAgendaSearch } from './agendaSearch';

export function Calendar({data,onWeek,onBook,onAppointment,filter,onFilter,search,focus=null,readOnly=false}:{focus?:CalendarFocus|null;readOnly?:boolean;data:Dashboard;onWeek:(date:string)=>void;onBook:(date?:string,therapistId?:string,slotId?:string)=>void;onAppointment:(a:Appointment)=>void;filter:string;onFilter:(id:string)=>void;search:string}) {
  const [view,setView]=useState<'week'|'day'>('week');
  const [day,setDay]=useState(data.anchorDate);
  const root=useRef<HTMLElement>(null),handledFocus=useRef<number|null>(null);
  const zone=data.clinic.time_zone;
  const focusDate=focus?dateAt(focus.startsAt,zone):null;
  const focusInWeek=focusDate!==null&&focusDate>=data.weekStart&&focusDate<addDays(data.weekStart,7);
  const weekend=addDays(data.weekStart,5);
  const hasWeekend=[...data.appointments,...data.slots].some(a=>dateAt(a.starts_at,zone)>=weekend)||(focusInWeek&&focusDate!==null&&focusDate>=weekend);
  const weekDays=hasWeekend?7:5;
  const days=view==='week'?Array.from({length:weekDays},(_,i)=>addDays(data.weekStart,i)):[day];
  const appointments=data.appointments.filter(a=>(filter==='all'||a.therapist_id===filter)&&matchesAgendaSearch(search,a.patient_name,a.therapist_name));
  const available=data.slots.filter(s=>filter==='all'||s.therapist_id===filter);
  const times=[...appointments,...available];
  const focusMinute=focus&&focusInWeek?minutesAt(focus.startsAt,zone):null;
  const startHour=Math.min(9,...times.map(s=>Math.floor(minutesAt(s.starts_at,zone)/60)),focusMinute===null?9:Math.floor(focusMinute/60));
  const endHour=Math.max(17,...times.map(s=>Math.ceil(minutesAt(s.ends_at,zone)/60)),focusMinute===null?17:Math.ceil((focusMinute+1)/60));
  const hourHeight=64;
  const gridHeight=(endHour-startHour)*hourHeight;
  const isTarget=(a:Appointment)=>Boolean(focus&&focusInWeek&&a.id===focus.appointmentId&&Date.parse(a.starts_at)===Date.parse(focus.startsAt));
  const needsMarker=Boolean(focus&&focusInWeek&&!appointments.some(isTarget));
  useEffect(()=>{
    if(!focus||!focusInWeek||handledFocus.current===focus.requestId)return;
    if(focus.showWeek&&view!=='week'){setView('week');return;}
    if(view==='day'&&day!==focusDate){setDay(focusDate!);return;}
    const target=root.current?.querySelector<HTMLElement>('[data-calendar-focus]');
    if(!target)return;
    handledFocus.current=focus.requestId;
    target.focus({preventScroll:true});
    target.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center',inline:'nearest'});
  },[focus,focusInWeek,focusDate,view,day,data]);
  const move=(direction:number)=>{
    if(view==='week')onWeek(addDays(data.weekStart,direction*7));
    else {const next=addDays(day,direction);setDay(next);if(next<data.weekStart||next>=addDays(data.weekStart,7))onWeek(addDays(data.weekStart,direction*7));}
  };
  return <section ref={root} className="calendar-panel panel" aria-label="Agenda de turnos">
    <div className="calendar-toolbar">
      <div className="date-controls"><div className="joined-arrows"><button className="icon-button" aria-label={view==='week'?'Semana anterior':'Día anterior'} onClick={()=>move(-1)}><ChevronLeft size={17}/></button><button className="icon-button" aria-label={view==='week'?'Semana siguiente':'Día siguiente'} onClick={()=>move(1)}><ChevronRight size={17}/></button></div>
        <h2>{view==='week'?`${fmtDate(data.weekStart,{day:'numeric'})} – ${fmtDate(addDays(data.weekStart,weekDays-1),{day:'numeric',month:'short',year:'numeric'})}`:fmtDate(day,{day:'numeric',month:'short',year:'numeric'})}</h2>
      </div>
      <div className="calendar-view"><button className="subtle-button" onClick={()=>{onWeek(addDays(data.anchorDate,-((new Date(`${data.anchorDate}T12:00:00Z`).getUTCDay()+6)%7)));setDay(data.anchorDate);}}>Próximos</button><div className="segmented"><button className={view==='week'?'selected':''} onClick={()=>setView('week')}>Semana</button><button className={view==='day'?'selected':''} onClick={()=>{setDay(data.weekStart);setView('day');}}>Día</button></div></div>
    </div>
    <div className="calendar-filters"><span className="filter-label"><SlidersHorizontal size={14}/>Profesionales</span><button className={`filter-chip ${filter==='all'?'active':''}`} onClick={()=>onFilter('all')}>Todos</button>{data.therapists.map((t,i)=><button key={t.id} className={`filter-chip ${filter===t.id?'active':''}`} onClick={()=>onFilter(t.id)}><span className={`color-dot doctor-${i}`}/>{t.name}</button>)}<span className="timezone-label">{zone.replaceAll('_',' ')}</span></div>
    <div className="calendar-scroll">
      <div className="calendar-grid" style={{minWidth:view==='week'?620:300}}>
        <div className="day-headers" style={{gridTemplateColumns:`48px repeat(${days.length},1fr)`}}><div className="time-header"><CalendarDays size={15}/></div>{days.map(date=><button key={date} className={`day-heading ${date===data.anchorDate?'highlight':''}`} onClick={()=>{setDay(date);setView('day');}}><span>{fmtDate(date,{weekday:'short'}).replace('.','')}</span><strong>{fmtDate(date,{day:'numeric'})}</strong></button>)}</div>
        <div className="calendar-body" style={{gridTemplateColumns:`48px repeat(${days.length},1fr)`,height:gridHeight}}>
          <div className="time-column">{Array.from({length:endHour-startHour},(_,i)=><span key={i} style={{top:i*hourHeight}}>{String(startHour+i).padStart(2,'0')}:00</span>)}</div>
          {days.map(date=>{
            const dayEvents=appointments.filter(a=>dateAt(a.starts_at,zone)===date);
            const free=available.filter(s=>dateAt(s.starts_at,zone)===date);
            const shownDoctors=filter==='all'?data.therapists.map(t=>t.id):[filter];
            return <div className="day-column" key={date} style={{backgroundSize:`100% ${hourHeight}px`}}>
              {free.map(slot=>{const doctorIndex=shownDoctors.indexOf(slot.therapist_id);return <button key={slot.id} className="open-slot" disabled={readOnly} aria-label={`Reservar ${fmtDate(date)} a las ${fmtTime(slot.starts_at,zone)} con ${data.therapists.find(t=>t.id===slot.therapist_id)?.name}`} title={`Disponible · ${fmtTime(slot.starts_at,zone)}`} onClick={()=>onBook(date,slot.therapist_id,slot.id)} style={{top:(minutesAt(slot.starts_at,zone)-startHour*60)/60*hourHeight,height:Math.max(28,(minutesAt(slot.ends_at,zone)-minutesAt(slot.starts_at,zone))/60*hourHeight-4),left:`calc(${doctorIndex/shownDoctors.length*100}% + 4px)`,width:`calc(${100/shownDoctors.length}% - 8px)`}}><Plus size={12}/><span>{fmtTime(slot.starts_at,zone)}</span></button>;})}
              {dayEvents.map(a=>{const concurrent=dayEvents.some(b=>b.id!==a.id&&Date.parse(b.starts_at)<Date.parse(a.ends_at)&&Date.parse(a.starts_at)<Date.parse(b.ends_at));const lanes=concurrent?shownDoctors.length:1;const doctorIndex=concurrent?shownDoctors.indexOf(a.therapist_id):0;const color=data.therapists.findIndex(t=>t.id===a.therapist_id);return <button key={a.id} className={`appointment doctor-${color}${isTarget(a)?' calendar-focus-target':''}`} data-calendar-focus={isTarget(a)?'':undefined} onClick={()=>onAppointment(a)} style={{top:(minutesAt(a.starts_at,zone)-startHour*60)/60*hourHeight,height:Math.max(43,(minutesAt(a.ends_at,zone)-minutesAt(a.starts_at,zone))/60*hourHeight-4),left:`calc(${doctorIndex/lanes*100}% + 4px)`,width:`calc(${100/lanes}% - 8px)`}} title={`${a.patient_name} · ${a.therapist_name} · ${fmtTime(a.starts_at,zone)}`} aria-label={`${a.patient_name} · ${a.therapist_name} · ${fmtTime(a.starts_at,zone)}`}><span className="appointment-heading"><span className="event-time">{fmtTime(a.starts_at,zone)}</span><strong>{a.patient_name}</strong></span><span className="event-doctor">{a.therapist_name}</span></button>;})}
              {needsMarker&&focus&&focusDate===date&&<div key={focus.requestId} className="calendar-location-marker calendar-focus-target" data-calendar-focus="" tabIndex={-1} role="note" aria-label={`${focus.kind==='cancelled'?'Turno cancelado':'Horario de la notificación'} · ${fmtDate(date)} · ${fmtTime(focus.startsAt,zone)}`} style={{top:(minutesAt(focus.startsAt,zone)-startHour*60)/60*hourHeight}}><strong>{fmtTime(focus.startsAt,zone)}</strong><span>{focus.kind==='cancelled'?'Turno cancelado':'Horario de la notificación'}</span></div>}
            </div>;
          })}
        </div>
        <div className="calendar-day-footers" style={{gridTemplateColumns:`48px repeat(${days.length},1fr)`}}><span/>{days.map(date=><button key={date} disabled={readOnly} onClick={()=>onBook(date)}><Plus size={12}/>{available.filter(s=>dateAt(s.starts_at,zone)===date).length} libres</button>)}</div>
      </div>
    </div>
    <div className="calendar-legend"><span><i className="legend-booked"/>Turno confirmado</span><span><i className="legend-open"/>Horario disponible</span><span className="legend-hint">{readOnly?'Vista de tu agenda':'Hacé clic en un horario para reservar'}</span></div>
  </section>;
}
