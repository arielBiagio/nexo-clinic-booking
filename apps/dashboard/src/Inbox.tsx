import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bot, CheckCheck, Headphones, MessageSquare, Sparkles, Trash2 } from 'lucide-react';
import type { Chat, Dashboard } from './types';
import { api, initials } from './api';
import { PatientCard } from './PatientCard';

export function Inbox({data,selected,onSelect,onRefresh,notify,onDelete,onRemoved}:{data:Dashboard;selected:string|null;onSelect:(id:string)=>void;onRefresh:()=>void;notify:(s:string)=>void;onDelete:(id:string)=>Promise<void>;onRemoved:()=>void}) {
  const [tab,setTab]=useState<'pending'|'all'>('pending'),[chat,setChat]=useState<Chat|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [mobileDetailOpen,setMobileDetailOpen]=useState(Boolean(selected));
  const messages=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),followLatest=useRef(true),lastConversation=useRef<string|null>(null);
  const drafts=useRef(new Map<string,string>());
  const cases=data.conversations.filter(c=>c.messageCount>0&&(tab==='all'||c.handoff_id));
  const current=selected&&data.conversations.some(c=>c.id===selected)?selected:cases[0]?.id;
  useEffect(()=>{if(selected)setMobileDetailOpen(true);},[selected]);
  useEffect(()=>{
    setText(current?drafts.current.get(current)??'':'');setChat(null);setError('');
    if(!current)return;
    let active=true;
    const load=()=>api<Chat>(`/demo/conversations/${current}`).then(c=>{if(active)setChat(c);}).catch(e=>{if(active)setError(e.message);});
    void load();const timer=setInterval(()=>void load(),4000);return()=>{active=false;clearInterval(timer);};
  },[current]);
  useLayoutEffect(()=>{
    const log=messages.current;
    if(log&&(lastConversation.current!==chat?.id||followLatest.current))log.scrollTop=log.scrollHeight;
    lastConversation.current=chat?.id??null;
  },[chat?.id,chat?.messages.length,mobileDetailOpen]);
  useLayoutEffect(()=>{
    const resize=()=>{
      const field=textarea.current;if(!field)return;
      field.style.height='auto';
      const limit=Math.min(128,Math.max(64,Math.round(window.innerHeight*.17)));
      field.style.height=`${Math.max(44,Math.min(field.scrollHeight,limit))}px`;
      field.style.overflowY=field.scrollHeight>limit?'auto':'hidden';
      if(messages.current&&followLatest.current)messages.current.scrollTop=messages.current.scrollHeight;
    };
    resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);
  },[text,chat?.id,mobileDetailOpen]);
  const reply=async()=>{if(!chat||!text.trim()||busy)return;setBusy(true);setError('');try{followLatest.current=true;setChat(await api<Chat>(`/demo/conversations/${chat.id}/reply`,{messageId:crypto.randomUUID(),text:text.trim()}));drafts.current.delete(chat.id);setText('');onRefresh();notify('Respuesta enviada al simulador del paciente.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const resolve=async()=>{if(!chat||busy)return;setBusy(true);setError('');try{await api(`/demo/conversations/${chat.id}/resolve`,{mode:'active'});setChat(await api<Chat>(`/demo/conversations/${chat.id}`));onRefresh();notify('Caso resuelto. El asistente puede continuar.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const remove=async()=>{if(!chat||busy)return;setBusy(true);setError('');try{await onDelete(chat.id);setMobileDetailOpen(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className={`inbox panel ${mobileDetailOpen?'show-conversation':''}`} aria-label="Conversaciones de recepción">
    <div className="inbox-list">
      <div className="inbox-list-heading"><h2>Bandeja de recepción</h2><span className="count-badge">{data.conversations.filter(c=>c.handoff_id).length}</span></div>
      <div className="inbox-tabs"><button className={tab==='pending'?'active':''} onClick={()=>{setTab('pending');const first=data.conversations.find(c=>c.handoff_id);if(first)onSelect(first.id);}}>Por atender</button><button className={tab==='all'?'active':''} onClick={()=>setTab('all')}>Todas</button></div>
      <div className="inbox-cases">
        {!cases.length&&<div className="empty-inbox"><CheckCheck size={28}/><strong>Todo al día</strong><p>No hay conversaciones esperando.</p></div>}
        {cases.map(c=><button key={c.id} disabled={busy} className={`conversation-item ${current===c.id?'selected':''}`} onClick={()=>{onSelect(c.id);setMobileDetailOpen(true);}}><span className="patient-avatar">{initials(c.patient_name)}</span><div><strong>{c.patient_name}</strong><p>{c.preview}</p><span>{c.handoff_id?'Necesita recepción':c.status==='human_led'?'Atención humana':'Asistente'}</span></div>{c.handoff_id&&<i className="unread-dot"/>}</button>)}
      </div>
      <button className="removed-link" onClick={onRemoved}>Ver conversaciones eliminadas</button>
    </div>
    <div className="inbox-detail">{chat?<>
      <div className="inbox-context">
        <div className="inbox-person">
          <button className="icon-button inbox-back" aria-label="Volver a conversaciones" onClick={()=>setMobileDetailOpen(false)}><ArrowLeft size={19}/></button>
          <div className="patient-avatar large">{initials(chat.name)}</div>
          <div className="inbox-person-info"><h2 title={chat.name}>{chat.name}</h2><span>Paciente de prueba</span></div>
          <span className={`status-pill ${chat.status==='active'?'green':'amber'}`}>{chat.status==='active'?<Bot size={13}/>:<Headphones size={13}/>} {chat.status==='active'?'Asistente activo':'Atención humana'}</span>
          <button type="button" className="icon-button danger-icon" aria-label="Eliminar conversación" title="Eliminar conversación; sus turnos se conservan" disabled={busy} onClick={()=>void remove()}><Trash2 size={17}/></button>
        </div>
        <PatientCard key={chat.id} conversationId={chat.id} collapsible onSaved={()=>{onRefresh();void api<Chat>(`/demo/conversations/${chat.id}`).then(setChat);}}/>
      </div>
      <div ref={messages} className="inbox-messages" role="log" aria-label="Mensajes de recepción" tabIndex={0} onScroll={()=>{const log=messages.current;if(log)followLatest.current=log.scrollHeight-log.scrollTop-log.clientHeight<48;}}>{chat.messages.map(m=><div key={m.id} className={`chat-message ${m.role}`}><span className="message-author">{m.role==='patient'?chat.name:m.role==='staff'?'Recepción':'Asistente'}</span><p>{m.text}</p></div>)}</div>
      <form className="staff-reply" onSubmit={e=>{e.preventDefault();void reply();}}>
        <div className="composer-heading"><label htmlFor="staff-message">Responder como recepción</label><span>Al responder, el asistente se pausa.</span></div>
        <textarea ref={textarea} id="staff-message" placeholder="Escribí tu respuesta…" value={text} rows={1} maxLength={500} onFocus={()=>{if(selected!==chat.id)onSelect(chat.id);}} onChange={e=>{setText(e.target.value);drafts.current.set(chat.id,e.target.value);}}/>
        {error&&<p className="error-message" role="alert">{error}</p>}
        <div className="composer-actions"><span className="composer-counter">{text.length} / 500</span><div className="composer-buttons">
          {chat.status!=='active'&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void resolve()}><CheckCheck size={15}/>Resolver caso</button>}
          <button className="primary-button" disabled={busy||!text.trim()} type="submit">Enviar<ArrowUp size={15}/></button>
        </div></div>
      </form>
    </>:<div className="empty-detail"><MessageSquare size={36}/><h2>Elegí una conversación</h2><p>El historial y las respuestas van a aparecer acá.</p>{error&&<p className="error-message" role="alert">{error}</p>}<span><Sparkles size={15}/>Tu equipo y el asistente, en un solo lugar.</span></div>}</div>
  </section>;
}
