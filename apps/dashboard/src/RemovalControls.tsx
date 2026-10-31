import {useEffect,useState} from 'react';
import {Trash2,Undo2} from 'lucide-react';
import {api,dateAt,fmtDate,fmtTime} from './api';
export type RemovedKind='appointments'|'conversations';
export function RemoveAction({label,description,onRemove}:{label:string;description:string;onRemove:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const remove=async()=>{setBusy(true);setError('');try{await onRemove();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="remove-action"><button type="button" className="danger-button" disabled={busy} onClick={()=>void remove()}><Trash2 size={16}/>{busy?'Quitando…':label}</button><p>{description}</p>{error&&<p className="error-message" role="alert">{error}</p>}</div>;
}
export function RemovedItems({kind,zone,onRestore}:{kind:RemovedKind;zone:string;onRestore:(kind:RemovedKind,id:string)=>Promise<void>}) {
  const [items,setItems]=useState<{id:string;label:string;at:string}[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('');
  const load=async()=>{setItems(await api(`/demo/removed/${kind}`));};
  useEffect(()=>{let active=true;api<typeof items>(`/demo/removed/${kind}`).then(r=>{if(active)setItems(r);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[kind]);
  const restore=async(id:string)=>{setBusy(id);setError('');try{await onRestore(kind,id);await load();}catch(e){setError((e as Error).message);}finally{setBusy(null);}};
  return <div className="removed-items"><p>{kind==='appointments'?'Podés recuperar un turno si el horario sigue libre y vigente.':'Recuperá una conversación con su ficha y su estado de atención anterior.'}</p>{loading?<p>Cargando…</p>:!items.length?<p>No hay {kind==='appointments'?'turnos quitados':'conversaciones eliminadas'}.</p>:<ul>{items.map(item=><li key={item.id}><div><strong>{item.label}</strong><span>{fmtDate(dateAt(item.at,zone))} · {fmtTime(item.at,zone)}</span></div><button type="button" className="secondary-button" disabled={busy!==null} onClick={()=>void restore(item.id)}><Undo2 size={15}/>{busy===item.id?'Restaurando…':'Restaurar'}</button></li>)}</ul>}{error&&<p className="error-message" role="alert">{error}</p>}</div>;
}
