import { useEffect, useState } from 'react';

export type Theme='light'|'dark';
const key='nexo-theme';
export function initializeTheme():Theme{
  let theme:Theme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  try{const saved=localStorage.getItem(key);if(saved==='light'||saved==='dark')theme=saved;localStorage.removeItem('nexo-dark-palette');}catch{/* System appearance remains available. */}
  document.documentElement.dataset.theme=theme;
  delete document.documentElement.dataset.palette;
  return theme;
}

export function useTheme(){
  const [theme,setTheme]=useState<Theme>(()=>document.documentElement.dataset.theme==='dark'?'dark':'light');
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    try{localStorage.setItem(key,theme);}catch{/* Appearance still applies in this tab. */}
  },[theme]);
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key===key&&(event.newValue==='light'||event.newValue==='dark'))setTheme(event.newValue);};
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[]);
  return {theme,setTheme,toggleTheme:()=>setTheme(value=>value==='light'?'dark':'light')};
}

export type AppearanceSettings=ReturnType<typeof useTheme>;
