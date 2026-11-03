import { useCallback,useEffect,useRef,useState } from 'react';
import { api } from './api';

export function useInboxAlerts(enabled:boolean,pageTitle:string,notify:(text:string)=>void){
  const [unread,setUnread]=useState<Record<string,number>>({});
  const [permission,setPermission]=useState<NotificationPermission|'unsupported'>(()=>typeof Notification==='undefined'?'unsupported':Notification.permission);
  const previous=useRef<number|null>(null),notifyRef=useRef(notify);notifyRef.current=notify;
  const request=useRef(0);
  const refresh=useCallback(async()=>{
    if(!enabled)return;
    const currentRequest=++request.current;
    try{
      const rows=await api<{id:string;unread_count:number}[]>('/inbox/unread');
      if(currentRequest!==request.current)return;
      const next=Object.fromEntries(rows.map(row=>[row.id,row.unread_count]));
      const total=rows.reduce((sum,row)=>sum+row.unread_count,0);
      if(previous.current!==null&&total>previous.current){
        notifyRef.current('Hay mensajes nuevos en Conversaciones.');
        if(document.hidden&&typeof Notification!=='undefined'&&Notification.permission==='granted'){
          try{new Notification('Nexo · Mensaje nuevo',{body:'Tenés mensajes sin leer en Conversaciones.',tag:'nexo-inbox'});}catch{/* Tab title and unread badge remain available. */}
        }
      }
      previous.current=total;setUnread(next);
    }catch{/* AuthGate handles expired sessions; retry without displaying patient content. */}
  },[enabled]);
  useEffect(()=>{if(!enabled){request.current++;setUnread({});previous.current=null;return;}void refresh();const timer=setInterval(()=>void refresh(),5000);window.addEventListener('focus',refresh);return()=>{request.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};},[enabled,refresh]);
  const total=Object.values(unread).reduce((sum,count)=>sum+count,0);
  useEffect(()=>{document.title=total?`(${total}) mensajes nuevos · Nexo`:`Nexo · ${pageTitle}`;return()=>{document.title='Nexo';};},[total,pageTitle]);
  const requestPermission=async()=>{
    if(typeof Notification!=='undefined')try{setPermission(await Notification.requestPermission());}catch{setPermission('denied');}
  };
  return {unread,total,refresh,permission,requestPermission};
}
