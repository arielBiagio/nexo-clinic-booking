import { t } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

type Preferences={notifications:boolean;sound:boolean};
type Permission=NotificationPermission|'unsupported';
const permissionNow=():Permission=>typeof Notification==='undefined'||!window.isSecureContext?'unsupported':Notification.permission;

export function useNotifications(userId:string){
  const storageKey=`nexo-alert-settings:${userId}`;
  const [preferences,setPreferences]=useState<Preferences>(()=>{
    try{const saved=JSON.parse(localStorage.getItem(storageKey)??'null');if(saved)return {notifications:saved.notifications===true,sound:saved.sound===true};}catch{/* Private mode can disable storage. */}
    return {notifications:permissionNow()==='granted',sound:false};
  });
  const [permission,setPermission]=useState<Permission>(permissionNow),[soundReady,setSoundReady]=useState(false),[error,setError]=useState('');
  const audio=useRef<AudioContext|null>(null),lastSound=useRef(0),current=useRef(preferences);current.current=preferences;
  const soundSupported=typeof AudioContext!=='undefined';
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(preferences));}catch{/* Settings still apply in this tab. */}},[storageKey,preferences]);
  useEffect(()=>{
    const sync=()=>setPermission(permissionNow());window.addEventListener('focus',sync);document.addEventListener('visibilitychange',sync);
    return()=>{window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',sync);};
  },[]);
  useEffect(()=>()=>{const context=audio.current;audio.current=null;if(context)void context.close().catch(()=>{});},[]);
  const unlock=useCallback(async()=>{
    if(typeof AudioContext==='undefined')return false;
    try{
      const context=audio.current??new AudioContext();audio.current=context;
      context.onstatechange=()=>{if(audio.current===context)setSoundReady(context.state==='running');};
      if(context.state!=='running')await context.resume();
      const ready=context.state==='running';setSoundReady(ready);return ready;
    }catch{setSoundReady(false);return false;}
  },[]);
  // A saved preference still needs a user gesture after opening a new tab.
  useEffect(()=>{
    if(!preferences.sound||soundReady)return;
    const activate=()=>{void unlock();};document.addEventListener('pointerdown',activate);document.addEventListener('keydown',activate);
    return()=>{document.removeEventListener('pointerdown',activate);document.removeEventListener('keydown',activate);};
  },[preferences.sound,soundReady,unlock]);
  const chime=useCallback((preview=false)=>{
    const context=audio.current;
    if(!context||context.state!=='running'||!preview&&(!current.current.sound||Date.now()-lastSound.current<1500))return;
    try{
      const start=context.currentTime;
      for(const [offset,frequency] of [[0,660],[0.12,880]] as const){
        const oscillator=context.createOscillator(),gain=context.createGain();oscillator.type='sine';oscillator.frequency.value=frequency;
        gain.gain.setValueAtTime(0,start+offset);gain.gain.linearRampToValueAtTime(0.13,start+offset+0.015);gain.gain.exponentialRampToValueAtTime(0.0001,start+offset+0.17);
        oscillator.connect(gain);gain.connect(context.destination);oscillator.start(start+offset);oscillator.stop(start+offset+0.19);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      }
      lastSound.current=Date.now();
    }catch{/* A blocked audio device must not interrupt notifications. */}
  },[]);
  const setSound=async(enabled:boolean)=>{
    setError('');
    if(enabled&&!await unlock()){setError(t("El navegador no permitió el sonido. Volvé a activar la opción de sonido."));return;}
    setPreferences(value=>({...value,sound:enabled}));if(enabled)chime(true);
  };
  const setNotifications=async(enabled:boolean)=>{
    setError('');
    if(!enabled){setPreferences(value=>({...value,notifications:false}));return;}
    let allowed=permissionNow();
    try{if(allowed==='default')allowed=await Notification.requestPermission();}catch{setError(t("No pudimos solicitar el permiso de notificaciones."));return;}
    setPermission(allowed);setPreferences(value=>({...value,notifications:allowed==='granted'}));
  };
  const announce=useCallback((kind:'activity'|'attention')=>{
    chime();
    if(current.current.notifications&&document.hidden&&permissionNow()==='granted')try{
      new Notification(kind==='activity'?t("Nexo · Actividad de turnos"):t("Nexo · Atención pendiente"),{
        body:kind==='activity'?t("Hay movimientos nuevos en la agenda."):t("Hay conversaciones por atender en recepción."),tag:`nexo-${kind}`,silent:true,
      });
    }catch{/* The bell and conversation badge remain available. */}
  },[chime]);
  const onActivity=useCallback(()=>announce('activity'),[announce]),onAttention=useCallback(()=>announce('attention'),[announce]);
  return {permission,notificationsEnabled:preferences.notifications&&permission==='granted',soundEnabled:preferences.sound,soundReady,soundSupported,error,setNotifications,setSound,onActivity,onAttention};
}

export type NotificationSettings=ReturnType<typeof useNotifications>;
