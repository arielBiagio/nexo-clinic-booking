import type { CSSProperties } from 'react';
import { Check, Palette } from 'lucide-react';
import type { AppearanceSettings } from './useTheme';

const modes=[
  {theme:'light',name:'Claro',description:'Fondo claro',background:'#f7f8fa',surface:'#ffffff',accent:'#23675e',soft:'#edf5f1'},
  {theme:'dark',name:'Obsidiana',description:'Oscuro con acento turquesa',background:'#0c1013',surface:'#161d22',accent:'#7bced4',soft:'#222d34'},
] as const;

export function AppearancePicker({appearance,onPreview}:{appearance:AppearanceSettings;onPreview:()=>void}){
  return <section className="preference-group appearance-picker" aria-labelledby="appearance-heading">
    <div className="appearance-heading"><Palette size={19}/><h3 id="appearance-heading">Apariencia</h3></div>
    <p className="preference-note">Elegí entre modo claro y oscuro.</p>
    <div className="palette-options" aria-label="Modo de color">{modes.map(palette=>{
      const active=appearance.theme===palette.theme;
      const style={'--preview-bg':palette.background,'--preview-surface':palette.surface,'--preview-accent':palette.accent,'--preview-soft':palette.soft} as CSSProperties;
      return <button key={palette.theme} className={`palette-option${active?' selected':''}`} style={style} aria-pressed={active} aria-label={`${palette.name}: ${palette.description}`} onClick={()=>appearance.setTheme(palette.theme)}>
        <span className="palette-preview" aria-hidden="true"><span className="palette-preview-rail"><i/><i/><i/></span><span className="palette-preview-main"><span className="palette-preview-header"><i/><b/></span><span className="palette-preview-stats"><i/><i/><i/></span><span className="palette-preview-agenda"><i/><i/><i/></span></span>{active&&<span className="palette-selected"><Check size={13}/></span>}</span>
        <strong>{palette.name}</strong><small>{palette.description}</small>
      </button>;
    })}</div>
    <button className="secondary-button" onClick={onPreview}>Ver en el panel</button>
  </section>;
}
