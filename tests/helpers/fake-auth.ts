import { randomUUID } from 'node:crypto';
import type { Sql } from '../../packages/db/src/client.js';

/** HTTP-shaped Supabase Auth double. It never contacts Supabase or sends email. */
export class FakeAuth {
  readonly url='http://fake-auth.invalid';
  readonly users=new Map<string,{id:string;email:string;password:string}>();
  readonly access=new Map<string,string>();
  readonly refresh=new Map<string,string>();
  readonly calls:{path:string;method:string}[]=[];
  private freeIds:string[]=[];
  async initialize(db:Sql){
    // PGlite serializes transactions: preallocate Auth FK targets to avoid a second
    // connection's Auth insert waiting for the staff transaction that invoked it.
    this.freeIds=Array.from({length:40},()=>randomUUID());
    await db.query('insert into auth.users(id) select value::uuid from jsonb_array_elements_text($1::jsonb)',[JSON.stringify(this.freeIds)]);
  }
  add(email:string,password='QA-only-password-2026!'){
    const id=this.freeIds.shift();if(!id)throw new Error('Fake Auth pool exhausted');
    this.users.set(id,{id,email,password});return id;
  }
  private user(id:string){const user=this.users.get(id)!;return {id,email:user.email,aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email'},user_metadata:{},is_anonymous:false};}
  private session(id:string){const access_token=`qa-access-${randomUUID()}`,refresh_token=`qa-refresh-${randomUUID()}`;this.access.set(access_token,id);this.refresh.set(refresh_token,id);return {access_token,refresh_token,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:this.user(id)};}
  readonly fetch:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));if(url.origin!==this.url)throw new Error('Unexpected external request in isolated QA');
    const method=init?.method??'GET',headers=new Headers(init?.headers),body=init?.body?JSON.parse(String(init.body)):{};
    const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    this.calls.push({path:url.pathname,method});
    const access=headers.get('authorization')?.replace(/^Bearer /,'')??'';
    if(url.pathname==='/auth/v1/admin/users'&&method==='POST'){
      if([...this.users.values()].some(u=>u.email===body.email))return json({msg:'User already registered'},422);
      const id=this.add(body.email,body.password);return json(this.user(id));
    }
    if(url.pathname.startsWith('/auth/v1/admin/users/')&&method==='DELETE'){
      const id=url.pathname.split('/').at(-1)!;this.users.delete(id);return json({});
    }
    if(url.pathname==='/auth/v1/token'){
      if(url.searchParams.get('grant_type')==='refresh_token'){
        const id=this.refresh.get(body.refresh_token);if(!id)return json({msg:'Invalid refresh'},401);
        this.refresh.delete(body.refresh_token);return json(this.session(id));
      }
      const user=[...this.users.values()].find(u=>u.email===body.email&&u.password===body.password);
      return user?json(this.session(user.id)):json({msg:'Invalid credentials'},400);
    }
    if(url.pathname==='/auth/v1/user'){
      const id=this.access.get(access);return id&&this.users.has(id)?json(this.user(id)):json({msg:'Invalid token'},401);
    }
    if(url.pathname==='/auth/v1/logout'){this.access.delete(access);return json({});}
    return json({msg:'Unknown fake auth route'},404);
  };
}
