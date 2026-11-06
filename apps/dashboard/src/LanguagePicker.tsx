import { Languages } from 'lucide-react';
import { setLanguage, useLanguage } from './i18n';

export function LanguagePicker() {
  const language = useLanguage();
  return <label className="language-picker">
    <Languages size={17} aria-hidden="true"/>
    <span className="sr-only">{language === 'en' ? 'Interface language' : 'Idioma de la interfaz'}</span>
    <select value={language} onChange={event => setLanguage(event.target.value === 'en' ? 'en' : 'es')}>
      <option value="es">ES</option>
      <option value="en">EN</option>
    </select>
  </label>;
}
