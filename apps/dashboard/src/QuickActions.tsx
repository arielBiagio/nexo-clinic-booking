import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, Plus, UserPlus } from 'lucide-react';

export function QuickActions({canManageStaff,onBook,onTeam}:{canManageStaff:boolean;onBook:()=>void;onTeam:()=>void}){
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    menu.current?.querySelector('button')?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const keyboard=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        const items=[...(menu.current?.querySelectorAll('button')??[])];if(!items.length)return;
        event.preventDefault();const index=items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index+(event.key==='ArrowDown'?1:items.length-1)+items.length)%items.length]?.focus();
      }
    };
    document.addEventListener('pointerdown',outside);root.current?.addEventListener('keydown',keyboard);
    return()=>{document.removeEventListener('pointerdown',outside);root.current?.removeEventListener('keydown',keyboard);};
  },[open]);
  return <div className={`quick-actions${open?' is-open':''}`} ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}>
    {open&&<div ref={menu} id="quick-actions-menu" className="quick-actions-menu" role="menu" aria-label="Crear">
      <button role="menuitem" onClick={()=>{setOpen(false);trigger.current?.focus();onBook();}}><CalendarPlus size={19}/><span>Nuevo turno</span></button>
      {canManageStaff&&<button role="menuitem" onClick={()=>{setOpen(false);trigger.current?.focus();onTeam();}}><UserPlus size={19}/><span>Nuevo rol<small>Equipo</small></span></button>}
    </div>}
    <button className="quick-actions-trigger" ref={trigger} aria-label={open?'Cerrar acciones rápidas':'Abrir acciones rápidas'} aria-expanded={open} aria-haspopup="menu" aria-controls="quick-actions-menu" onClick={()=>setOpen(value=>!value)}><Plus size={27}/></button>
  </div>;
}
