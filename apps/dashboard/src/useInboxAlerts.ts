import { t } from './i18n';
import { useCallback,useEffect,useRef,useState } from 'react';
import { api } from './api';

export function useInboxAlerts(enabled:boolean,pageTitle:string,notify:(text:string)=>void,onAttention:()=>void){
  const [unread,setUnread]=useState<Record<string,number>>({});
  const attentionRef=useRef(onAttention);attentionRef.current=onAttention;
  const previous=useRef<Set<string>|null>(null),notifyRef=useRef(notify);notifyRef.current=notify;
  const request=useRef(0);
  const refresh=useCallback(async()=>{
    if(!enabled)return;
    const currentRequest=++request.current;
    try{
      const rows=await api<{id:string;unread_count:number}[]>('/inbox/unread');
      if(currentRequest!==request.current)return;
      const next=Object.fromEntries(rows.map(row=>[row.id,1]));
      if(previous.current!==null&&rows.some(row=>!previous.current!.has(row.id))){
        notifyRef.current(t("Hay una conversación que necesita atención humana."));
        attentionRef.current();
      }
      previous.current=new Set(rows.map(row=>row.id));setUnread(next);
    }catch{/* AuthGate handles expired sessions; retry without displaying patient content. */}
  },[enabled]);
  useEffect(()=>{if(!enabled){request.current++;setUnread({});previous.current=null;return;}void refresh();const timer=setInterval(()=>void refresh(),5000);window.addEventListener('focus',refresh);return()=>{request.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};},[enabled,refresh]);
  const total=Object.values(unread).reduce((sum,count)=>sum+count,0);
  useEffect(()=>{document.title=total?t("({0}) conversaciones por atender · Nexo", [total]):`Nexo · ${pageTitle}`;return()=>{document.title='Nexo';};},[total,pageTitle]);
  return {unread,total,refresh};
}
