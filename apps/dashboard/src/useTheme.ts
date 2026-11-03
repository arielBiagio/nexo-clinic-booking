import { useEffect, useState } from 'react';

export type Theme='light'|'dark';
const key='nexo-theme';
const paletteKey='nexo-dark-palette';
export const darkPalettes=[
  {id:'graphite',name:'Grafito',description:'Grises neutros y azul suave',background:'#121416',surface:'#1c1f22',accent:'#8fb9db',soft:'#262b2e'},
  {id:'midnight',name:'Medianoche',description:'Azul profundo y azul lavanda',background:'#0d1423',surface:'#151f32',accent:'#91aef5',soft:'#202d43'},
  {id:'amethyst',name:'Amatista',description:'Tonos ciruela y lavanda',background:'#18141f',surface:'#231d2d',accent:'#c1a0e6',soft:'#30263d'},
  {id:'coffee',name:'Café',description:'Marrones cálidos y arena',background:'#1b1714',surface:'#28211d',accent:'#d5b38d',soft:'#372d25'},
  {id:'obsidian',name:'Obsidiana',description:'Casi negro con acento turquesa',background:'#0c1013',surface:'#161d22',accent:'#7bced4',soft:'#222d34'},
  {id:'forest',name:'Bosque',description:'La paleta verde original',background:'#101a17',surface:'#192620',accent:'#83c9b5',soft:'#22342b'},
] as const;
export type DarkPalette=typeof darkPalettes[number]['id'];
const isPalette=(value:unknown):value is DarkPalette=>darkPalettes.some(palette=>palette.id===value);
export function initializeTheme():Theme{
  let theme:Theme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  let palette:DarkPalette='forest';
  try{const saved=localStorage.getItem(key);if(saved==='light'||saved==='dark')theme=saved;const savedPalette=localStorage.getItem(paletteKey);if(isPalette(savedPalette))palette=savedPalette;}catch{/* System appearance remains available. */}
  document.documentElement.dataset.theme=theme;
  document.documentElement.dataset.palette=palette;
  return theme;
}

export function useTheme(){
  const [theme,setTheme]=useState<Theme>(()=>document.documentElement.dataset.theme==='dark'?'dark':'light');
  const [palette,setPalette]=useState<DarkPalette>(()=>isPalette(document.documentElement.dataset.palette)?document.documentElement.dataset.palette:'forest');
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    try{localStorage.setItem(key,theme);}catch{/* Appearance still applies in this tab. */}
  },[theme]);
  useEffect(()=>{
    document.documentElement.dataset.palette=palette;
    try{localStorage.setItem(paletteKey,palette);}catch{/* Palette still applies in this tab. */}
  },[palette]);
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key===key&&(event.newValue==='light'||event.newValue==='dark'))setTheme(event.newValue);if(event.key===paletteKey&&isPalette(event.newValue))setPalette(event.newValue);};
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[]);
  return {theme,palette,setTheme,toggleTheme:()=>setTheme(value=>value==='light'?'dark':'light'),selectPalette:(value:DarkPalette)=>{setPalette(value);setTheme('dark');}};
}

export type AppearanceSettings=ReturnType<typeof useTheme>;
