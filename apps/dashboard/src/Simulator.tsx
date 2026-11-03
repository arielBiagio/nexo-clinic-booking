import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, CircleCheck, Headphones, RotateCcw, Sparkles,Trash2 } from 'lucide-react';
import type { Chat, Choice } from './types';
import { api } from './api';
import { PatientCard } from './PatientCard';

export function Simulator({chat,setChat,onChange,onInbox,onDelete}:{chat:Chat|null;setChat:(c:Chat)=>void;onChange:()=>void;onInbox:(id:string)=>void;onDelete:(id:string)=>Promise<void>}) {
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const bottom=useRef<HTMLDivElement>(null);
  const id=chat?.id;
  const usesAI=chat?.ai?.provider==='openrouter';
  const modelLabel=chat?.ai?.model==='openai/gpt-4o-mini'?'GPT-4o mini':chat?.ai?.model;
  const connectionIssue:Record<string,string>={CONFIGURATION:'OpenRouter rechazó los parámetros del modelo.',AUTH:'OpenRouter no aceptó la clave configurada.',BUDGET:'OpenRouter informó un límite de saldo o presupuesto.',RATE_LIMIT:'Se alcanzó un límite de consultas. Probá más tarde.',INVALID_RESPONSE:'No pudimos procesar la respuesta de OpenRouter.',UNAVAILABLE:'No pudimos conectar con OpenRouter.'};
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth',block:'end'});},[chat?.messages.length]);
  useEffect(()=>{if(!id)return;let active=true;const timer=setInterval(()=>{api<Chat>(`/demo/conversations/${id}`).then(next=>{if(active)setChat(next);}).catch(()=>{});},3500);return()=>{active=false;clearInterval(timer);};},[id,setChat]);
  const send=async(choice?:Choice)=>{
    if(!chat||busy)return;const value=text.trim();if(!choice&&!value)return;
    setBusy(true);setError('');
    try {setChat(await api<Chat>(`/demo/conversations/${chat.id}/messages`,{messageId:crypto.randomUUID(),...(choice?{action:choice.action,...(choice.slotId?{slotId:choice.slotId}:{}),...(choice.appointmentId?{appointmentId:choice.appointmentId}:{})}:{text:value})}));setText('');onChange();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const restart=async()=>{setBusy(true);try{const next=await api<Chat>('/demo/conversations',{});sessionStorage.setItem('nexo-demo-chat',next.id);setChat(next);setError('');onChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const remove=async()=>{if(!chat||busy)return;setBusy(true);setError('');try{await onDelete(chat.id);await restart();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="simulator">
    <div className="sim-intro"><span className="sim-intro-icon"><Sparkles size={20}/></span><div><strong>Ponete del lado del paciente</strong><p>Probá una reserva o pedí ayuda. Los cambios aparecen en la agenda y la bandeja.</p></div></div>
    <div className="chat-person"><span className="assistant-avatar"><Bot size={20}/></span><div><strong>Asistente de Clínica Demo</strong><span><i/>{chat?.status==='active'?(usesAI?`${modelLabel} · OpenRouter`:'Recorrido guiado de prueba'):'Conversación con recepción'}</span></div><button className="icon-button" aria-label="Nueva conversación de prueba" onClick={()=>void restart()} disabled={busy}><RotateCcw size={17}/></button><button className="icon-button danger-icon" aria-label="Eliminar esta conversación de prueba" title="Eliminar conversación" onClick={()=>void remove()} disabled={busy||!chat}><Trash2 size={17}/></button></div>
    {chat?.ai?.error&&<div className="chat-connection-error" role="alert"><p>{connectionIssue[chat.ai.error]??'El asistente no está disponible.'} Este caso quedó en recepción.</p><button className="secondary-button full" disabled={busy} onClick={()=>void restart()}><RotateCcw size={14}/>Nueva prueba con IA</button></div>}
    {chat&&<details className="sim-patient"><summary>Mis datos · {chat.patient.name_collected?chat.patient.name:'nombre pendiente'} · {chat.patient.phone?'teléfono guardado':'teléfono pendiente'}</summary><PatientCard conversationId={chat.id} onSaved={()=>{void api<Chat>(`/demo/conversations/${chat.id}`).then(setChat);onChange();}}/></details>}
    <div className="chat-messages" role="log" aria-label="Conversación de prueba" aria-live="polite">
      {!chat&&<div className="loading-note">Preparando tu conversación…</div>}
      {chat?.messages.map(message=><div key={message.id} className={`chat-message ${message.role}`}><span className="message-author">{message.role==='patient'?'Vos, como paciente':message.role==='staff'?'Recepción':'Asistente'}</span><p>{message.text}</p></div>)}
      {busy&&<div className="typing-dots"><i/><i/><i/></div>}
      {!!chat?.choices.length&&<div className="chat-choices">{chat.choices.map((choice,i)=><button key={`${choice.action}-${i}`} disabled={busy} onClick={()=>void send(choice)}>{choice.action==='confirm'&&<CircleCheck size={14}/>} {choice.label}</button>)}</div>}
      {chat&&chat.status!=='active'&&<div className="handoff-chat-note"><Headphones size={17}/><span>La conversación quedó en manos de recepción.</span><button onClick={()=>onInbox(chat.id)}>Ver en la bandeja →</button></div>}
      <div ref={bottom}/>
    </div>
    {error&&<p className="error-message" role="alert">{error}</p>}
    <form className="chat-input" onSubmit={e=>{e.preventDefault();void send();}}><input aria-label="Mensaje como paciente" value={text} onChange={e=>setText(e.target.value)} placeholder="Escribí un mensaje de prueba…" maxLength={500}/><button aria-label="Enviar mensaje" className="send-button" disabled={busy||!text.trim()||!chat}><ArrowUp size={19}/></button></form>
    <p className="sim-disclaimer">{usesAI?'Datos ficticios · mensajes procesados por OpenRouter':'Simulación local · pacientes ficticios · sin envíos externos'}</p>
  </div>;
}
