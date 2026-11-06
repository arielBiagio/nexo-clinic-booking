import { t, useLanguage } from './i18n';
import { Users } from 'lucide-react';
import { initials } from './api';
import type { Therapist } from './types';

export function ProfessionalDirectory({professionals}:{professionals:Therapist[]}){
  useLanguage();
  return <div className="professional-directory">
    {professionals.length?<ul>{professionals.map(professional=><li key={professional.id}>
      <span className="patient-avatar" aria-hidden="true">{initials(professional.name)}</span>
      <div><strong>{professional.name}</strong>{professional.specialty&&<p>{t(professional.specialty)}</p>}</div>
    </li>)}</ul>:<div className="professional-directory-empty"><Users size={25}/><p>{t("No hay profesionales para mostrar.")}</p></div>}
  </div>;
}
