import type { CSSProperties } from 'react';
import { Check, Palette, Sun } from 'lucide-react';
import { darkPalettes, type AppearanceSettings } from './useTheme';

export function AppearancePicker({appearance,onPreview}:{appearance:AppearanceSettings;onPreview:()=>void}){
  return <section className="preference-group appearance-picker" aria-labelledby="appearance-heading">
    <div className="appearance-heading"><Palette size={19}/><h3 id="appearance-heading">Apariencia</h3></div>
    <p className="preference-note">Elegí una paleta para verla aplicada en el panel.</p>
    <button className={`appearance-light${appearance.theme==='light'?' selected':''}`} aria-pressed={appearance.theme==='light'} onClick={()=>appearance.setTheme('light')}><Sun size={17}/><span>Modo claro</span>{appearance.theme==='light'&&<Check size={16}/>}</button>
    <div className="palette-options" aria-label="Paletas oscuras">{darkPalettes.map(palette=>{
      const active=appearance.theme==='dark'&&appearance.palette===palette.id;
      const style={'--preview-bg':palette.background,'--preview-surface':palette.surface,'--preview-accent':palette.accent,'--preview-soft':palette.soft} as CSSProperties;
      return <button key={palette.id} className={`palette-option${active?' selected':''}`} style={style} aria-pressed={active} aria-label={`${palette.name}: ${palette.description}`} onClick={()=>appearance.selectPalette(palette.id)}>
        <span className="palette-preview" aria-hidden="true"><span className="palette-preview-rail"><i/><i/><i/></span><span className="palette-preview-main"><span className="palette-preview-header"><i/><b/></span><span className="palette-preview-stats"><i/><i/><i/></span><span className="palette-preview-agenda"><i/><i/><i/></span></span>{active&&<span className="palette-selected"><Check size={13}/></span>}</span>
        <strong>{palette.name}</strong><small>{palette.description}</small>
      </button>;
    })}</div>
    <button className="secondary-button" onClick={onPreview}>Ver en el panel</button>
  </section>;
}
