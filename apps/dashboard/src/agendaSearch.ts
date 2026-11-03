const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

/** Small spelling errors, including adjacent swapped letters, stay local to the visible agenda. */
function distance(left:string,right:string):number{
  const rows=Array.from({length:left.length+1},()=>Array<number>(right.length+1).fill(0));
  for(let i=0;i<=left.length;i++)rows[i]![0]=i;
  for(let j=0;j<=right.length;j++)rows[0]![j]=j;
  for(let i=1;i<=left.length;i++)for(let j=1;j<=right.length;j++){
    rows[i]![j]=Math.min(rows[i-1]![j]!+1,rows[i]![j-1]!+1,rows[i-1]![j-1]!+(left[i-1]===right[j-1]?0:1));
    if(i>1&&j>1&&left[i-1]===right[j-2]&&left[i-2]===right[j-1])rows[i]![j]=Math.min(rows[i]![j]!,rows[i-2]![j-2]!+1);
  }
  return rows[left.length]![right.length]!;
}

export function matchesAgendaSearch(query:string,...fields:string[]):boolean{
  const terms=normalize(query.slice(0,120)).split(' ').filter(Boolean).slice(0,12);
  if(!terms.length)return true;
  const words=fields.flatMap(field=>normalize(field).split(' ').filter(Boolean));
  return terms.every(term=>words.some(word=>{
    if(word.includes(term))return true;
    const tolerance=term.length>=8?2:term.length>=4?1:0;
    if(!tolerance)return false;
    return Math.abs(term.length-word.length)<=tolerance&&distance(term,word)<=tolerance
      ||word.length>term.length&&distance(term,word.slice(0,term.length))<=tolerance;
  }));
}
