import type { CSSProperties } from 'react';

type Variant='dashboard'|'chat'|'conversation'|'inbox'|'form'|'details'|'list'|'slots'|'auth'|'schedule';
function Block({width='100%',height=14,circle=false}:{width?:CSSProperties['width'];height?:number;circle?:boolean}){
  return <span className={`placeholder-block${circle?' placeholder-circle':''}`} style={{width,height}}/>;
}
function List({count}:{count:number}){
  return <div className="placeholder-list">{Array.from({length:count},(_,index)=><div className="placeholder-list-row" key={index}><Block width={36} height={36} circle/><div><Block width={index%2?'55%':'72%'}/><Block width="45%" height={11}/></div></div>)}</div>;
}
function Form({count}:{count:number}){
  return <div className="placeholder-form">{Array.from({length:count},(_,index)=><div key={index}><Block width="30%" height={12}/><Block height={41}/></div>)}<Block width={135} height={37}/></div>;
}
function Chat({full=false}:{full?:boolean}){
  return <div className={`placeholder-chat${full?' is-full':''}`}>{full&&<div className="placeholder-chat-person"><Block width={36} height={36} circle/><div><Block width="55%"/><Block width="36%" height={11}/></div></div>}<div className="placeholder-messages">{[0,1,2].map(index=><div className={`placeholder-bubble${index===1?' is-patient':''}`} key={index}><Block width="85%"/><Block width="60%" height={12}/></div>)}</div>{full&&<Block height={48}/>}</div>;
}
function CalendarShape(){
  return <div className="placeholder-panel placeholder-calendar"><div className="placeholder-heading"><Block width="35%" height={16}/><Block width={95} height={28}/></div><div className="placeholder-calendar-grid">{[0,1,2,3,4].map(index=><div key={index}><Block width="60%" height={12}/><span className={`placeholder-calendar-event event-${index%3}`}><Block height={38}/></span></div>)}</div></div>;
}

export function LoadingPlaceholder({variant='list',label='Cargando datos',count=3}:{variant?:Variant;label?:string;count?:number}){
  let content;
  if(variant==='dashboard')content=<><div className="placeholder-stats">{[0,1,2,3].map(index=><div className="placeholder-panel" key={index}><Block width="64%" height={13}/><Block width="30%" height={27}/></div>)}</div><div className="placeholder-heading"><Block width="23%" height={17}/><Block width="24%" height={36}/></div><div className="placeholder-agenda-layout"><CalendarShape/><div className="placeholder-panel"><Block width="70%" height={16}/><List count={3}/></div></div></>;
  else if(variant==='inbox')content=<div className="placeholder-panel placeholder-inbox"><div className="placeholder-inbox-list"><Block width="70%" height={16}/><List count={4}/></div><Chat full/></div>;
  else if(variant==='chat')content=<Chat/>;
  else if(variant==='conversation')content=<Chat full/>;
  else if(variant==='auth')content=<div className="placeholder-panel placeholder-auth"><Block width={112} height={32}/><Block width="75%" height={24}/><Form count={2}/></div>;
  else if(variant==='form')content=<Form count={count}/>;
  else if(variant==='details')content=<div className="placeholder-details">{Array.from({length:count},(_,index)=><div key={index}><Block width="75%" height={12}/><Block width="70%"/></div>)}</div>;
  else if(variant==='slots')content=<div className="placeholder-slots">{Array.from({length:count},(_,index)=><Block key={index} width={70} height={34}/>)}</div>;
  else if(variant==='schedule')content=<div className="placeholder-schedule">{[0,1,2,3].map(index=><div key={index}><Block width="22%"/><Block width="58%" height={35}/></div>)}</div>;
  else content=<List count={count}/>;
  return <div className={`loading-placeholder loading-placeholder--${variant}`} role="status" aria-busy="true"><span className="sr-only">{label}</span><div className="placeholder-visual" aria-hidden="true">{content}</div></div>;
}
