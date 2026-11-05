import { Temporal } from '@js-temporal/polyfill';

const weekdays=['lunes','martes','miercoles','jueves','viernes','sabado','domingo'] as const;
const normalize=(text:string)=>text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/** A numbered weekday is a single constraint: never drop its day number. */
export function numberedWeekdayDate(text:string,now:string,timeZone:string):{date:string|null;needsClarification:boolean} {
  const value=normalize(text);
  if(/\b(cada|todos|todas|toda)\b/.test(value))return {date:null,needsClarification:false};
  const matches=[...value.matchAll(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?:\s*,\s*|\s+)(?:proximo\s+)?(?:dia\s+)?(\d{1,2})\b(?![\d/:-]|\.\d)/g)];
  if(!matches.length)return {date:null,needsClarification:false};
  if(matches.length!==1)return {date:null,needsClarification:true};
  const match=matches[0]!,weekday=weekdays.indexOf(match[1] as typeof weekdays[number])+1,day=Number(match[2]);
  const suffix=value.slice(match.index!+match[0].length);
  if(/^\s*(?:h(?:s|oras?)?|a\.?m\.?|p\.?m\.?)(?!\w)/.test(suffix))return {date:null,needsClarification:false};
  const monthText=suffix.match(/^\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:de(?:l)?\s+)?(\d{4}))?\b/);
  if(day<1||day>31||/^\s+de\s+/.test(suffix)&&!monthText)return {date:null,needsClarification:true};
  const month=monthText?months.indexOf(monthText[1]!)+1:null,year=monthText?.[2]?Number(monthText[2]):null;
  const today=Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate(),candidates:string[]=[];
  for(let offset=0;offset<42;offset++){
    const date=today.add({days:offset});
    if(date.day===day&&date.dayOfWeek===weekday&&(!month||date.month===month)&&(!year||date.year===year))candidates.push(date.toString());
  }
  return candidates.length===1?{date:candidates[0]!,needsClarification:false}:{date:null,needsClarification:true};
}

export function calendarHints(now:string,timeZone:string) {
  const today=Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate();
  const nextWeek=today.subtract({days:today.dayOfWeek-1}).add({days:7});
  return {today:today.toString(),weekday:weekdays[today.dayOfWeek-1],tomorrow:today.add({days:1}).toString(),dayAfterTomorrow:today.add({days:2}).toString(),
    nextWeekdays:Object.fromEntries(weekdays.map((name,index)=>[name,today.add({days:(index+1-today.dayOfWeek+7)%7}).toString()])),
    followingWeek:Object.fromEntries(weekdays.map((name,index)=>[name,nextWeek.add({days:index}).toString()])),
  };
}

/** Pin simple calendar constraints independently of the LLM's date arithmetic. */
export function requestedLocalDate(text:string,now:string,timeZone:string):string|null {
  const value=normalize(text).trim();
  const today=Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate();
  if(/^no\b/.test(value))return null;
  const iso=value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if(iso){try{return Temporal.PlainDate.from(iso[1]!).toString();}catch{return null;}}
  const numbered=numberedWeekdayDate(text,now,timeZone);
  if(numbered.date||numbered.needsClarification)return numbered.date;
  // Written explicit dates remain the model's job; do not replace them with a weekday guess.
  if(/\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(value))return null;
  const dateText=value.replace(/\b(?:por|a|en|durante|para) la manana\b|\b(?:por|a|en|durante|para) las mananas\b|\bhorario (?:de manana|matutino)\b/g,'');
  if(/\bpasado manana\b/.test(dateText))return today.add({days:2}).toString();
  if(/\bmanana\b/.test(dateText))return today.add({days:1}).toString();
  if(/\bhoy\b/.test(value))return today.toString();
  const mentioned=weekdays.filter(day=>new RegExp(`\\b${day}\\b`).test(value));
  if(mentioned.length!==1||/\b(cada|todos|todas)\b/.test(value))return null;
  const weekday=weekdays.indexOf(mentioned[0]!)+1;
  if(/\b(semana que viene|proxima semana|semana proxima)\b/.test(value)){
    return today.subtract({days:today.dayOfWeek-1}).add({days:7+weekday-1}).toString();
  }
  if(/\bpasad[oa]\b/.test(value)){
    return today.subtract({days:(today.dayOfWeek-weekday+7)%7||7}).toString();
  }
  let days=(weekday-today.dayOfWeek+7)%7;
  if(days===0&&/\b(proximo|proxima|que viene)\b/.test(value))days=7;
  return today.add({days}).toString();
}
