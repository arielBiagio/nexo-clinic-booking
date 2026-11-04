/** Google errors expose only fixed codes, never tokens, URLs or provider response bodies. */
export class GoogleError extends Error {
  constructor(readonly code:string,readonly status=0,readonly retryAfter=0){super(code);}
}
export interface GoogleTokens {access_token:string;refresh_token:string;expires_at:number}
export class GoogleApi {
  constructor(readonly clientId:string,private readonly clientSecret:string){}
  async tokens(body:Record<string,string>){
    let response:Response;
    try{response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,...body}),signal:AbortSignal.timeout(10_000)});}
    catch{throw new GoogleError('GOOGLE_TEMPORARY');}
    const value=await response.json().catch(()=>({})) as Record<string,unknown>;
    if(!response.ok)throw new GoogleError(value.error==='invalid_grant'?'GOOGLE_RECONNECT':'GOOGLE_AUTH_FAILED',response.status);
    if(typeof value.access_token!=='string'||typeof value.expires_in!=='number')throw new GoogleError('GOOGLE_AUTH_FAILED');
    return {access_token:value.access_token,refresh_token:typeof value.refresh_token==='string'?value.refresh_token:undefined,expires_at:Math.floor(Date.now()/1000)+value.expires_in,scope:typeof value.scope==='string'?value.scope:''};
  }
  async request<T>(accessToken:string,path:string,method='GET',body?:unknown):Promise<T>{
    let response:Response;
    try{response=await fetch(`https://www.googleapis.com/calendar/v3${path}`,{method,headers:{Authorization:`Bearer ${accessToken}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10_000)});}
    catch{throw new GoogleError('GOOGLE_TEMPORARY');}
    if(!response.ok){
      const value=await response.json().catch(()=>({})) as {error?:{errors?:{reason?:string}[]}};
      const rateLimited=response.status===429||value.error?.errors?.some(e=>['rateLimitExceeded','userRateLimitExceeded'].includes(e.reason??''));
      throw new GoogleError(response.status===401?'GOOGLE_RECONNECT':rateLimited?'GOOGLE_RATE_LIMIT':response.status===403?'GOOGLE_PERMISSION':response.status===404?'GOOGLE_NOT_FOUND':response.status===410?'GOOGLE_GONE':response.status===409?'GOOGLE_CONFLICT':'GOOGLE_TEMPORARY',response.status,Math.min(3600,Number(response.headers.get('retry-after'))||0));
    }
    if(response.status===204)return undefined as T;
    return response.json() as Promise<T>;
  }
  async identity(accessToken:string){
    let response:Response;
    try{response=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(10_000)});}
    catch{throw new GoogleError('GOOGLE_TEMPORARY');}
    if(!response.ok)throw new GoogleError('GOOGLE_AUTH_FAILED');
    const user=await response.json() as {sub?:string;email?:string;email_verified?:boolean};
    if(!user.sub||!user.email||!user.email_verified)throw new GoogleError('GOOGLE_AUTH_FAILED');
    return {sub:user.sub,email:user.email};
  }
  async revoke(refreshToken:string){
    try{await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refreshToken}),signal:AbortSignal.timeout(10_000)});}catch{/* Local disconnect already prevents further work. */}
  }
}
