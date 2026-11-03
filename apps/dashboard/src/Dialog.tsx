import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({title,children,onClose,drawer=false}:{title:string;children:ReactNode;onClose:()=>void;drawer?:boolean}) {
  const ref=useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const old=document.body.style.overflow;document.body.style.overflow='hidden';
    ref.current?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape')closeRef.current();
      if(event.key==='Tab'){
        const items=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
        if(!items?.length)return;
        const first=items[0]!,last=items[items.length-1]!;
        if(event.shiftKey && (document.activeElement===first || document.activeElement===ref.current)){event.preventDefault();last.focus();}
        else if(!event.shiftKey && (document.activeElement===last || document.activeElement===ref.current)){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key);
    return ()=>{document.body.style.overflow=old;document.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return <div className={`modal-backdrop ${drawer?'drawer-backdrop':''}`} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className={`dialog ${drawer?'drawer':''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="Cerrar" onClick={onClose}><X size={20}/></button></div>
      {children}
    </div>
  </div>;
}
