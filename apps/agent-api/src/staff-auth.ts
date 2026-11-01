import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../../../packages/db/src/client.js';
import { DomainError } from '../../../packages/db/src/repository.js';

export type StaffRole='admin'|'reception'|'therapist';
export interface StaffPrincipal {id:string;email:string;name:string;role:StaffRole;therapistId:string|null}
declare module 'fastify' { interface FastifyRequest {staff?:StaffPrincipal} }
const credentials=z.strictObject({email:z.email().max(254),password:z.string().min(1).max(128)});
const newStaff=credentials.extend({password:z.string().min(12).max(128),name:z.string().trim().min(2).max(70),role:z.enum(['admin','reception','therapist']),therapistId:z.uuid().nullable()});
const changeStaff=z.strictObject({role:z.enum(['admin','reception','therapist']),active:z.boolean(),therapistId:z.uuid().nullable()});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const cookieName='nexo_staff';
const cookieValue=(request:FastifyRequest)=>request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1)??'';
type Tokens={access_token:string;refresh_token:string;expires_at:number};

/** Same-origin BFF. Neither Supabase tokens nor server keys are delivered to JavaScript. */
export class StaffAuth {
  readonly origin:URL;
  private readonly key:Buffer;
  private readonly attempts=new Map<string,{count:number;until:number}>();
  constructor(private readonly db:Sql,private readonly options:{url:string;publishableKey:string;secretKey:string;encryptionKey:string;origin:string;bootstrapEmail:string}){
    this.origin=new URL(options.origin);
    if(this.origin.protocol!=='https:'&&!this.isLocal)throw new Error('Staff origin requires HTTPS');
    this.key=Buffer.from(options.encryptionKey,'base64url');
    if(this.key.length!==32)throw new Error('SESSION_ENCRYPTION_KEY must contain 32 random bytes');
  }
  get isLocal(){return ['localhost','127.0.0.1','[::1]'].includes(this.origin.hostname);}
  private client(admin=false){return createClient(this.options.url,admin?this.options.secretKey:this.options.publishableKey,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(8_000)})}});}
  private encrypt(tokens:Tokens){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const body=Buffer.concat([cipher.update(JSON.stringify(tokens),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
  private decrypt(value:string):Tokens{const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')) as Tokens;}
  private cookie(reply:FastifyReply,value:string,maxAge:number){reply.header('Set-Cookie',`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.origin.protocol==='https:'?'; Secure':''}`);}
  assertOrigin(request:FastifyRequest){if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.headers.origin!==this.origin.origin)throw new DomainError('ORIGIN_NOT_ALLOWED',403);}
  private rateLimit(request:FastifyRequest){
    const now=Date.now();for(const [key,value] of this.attempts)if(value.until<=now)this.attempts.delete(key);
    const entry=this.attempts.get(request.ip)??{count:0,until:now+15*60_000};
    if(++entry.count>12)throw new DomainError('LOGIN_RATE_LIMIT',429);
    this.attempts.set(request.ip,entry);
  }
  private async principal(userId:string,db=this.db):Promise<StaffPrincipal>{
    const row=(await db.query<{user_id:string;email:string;display_name:string;role:StaffRole;therapist_id:string|null}>(`select s.user_id,s.email,s.display_name,s.role,t.id as therapist_id from public.staff_members s
      left join public.therapists t on t.staff_user_id=s.user_id where s.user_id=$1 and s.active`,[userId])).rows[0];
    if(!row||row.role==='therapist'&&!row.therapist_id)throw new DomainError('STAFF_ACCESS_REQUIRED',403);
    return {id:row.user_id,email:row.email,name:row.display_name,role:row.role,therapistId:row.therapist_id};
  }
  async authenticate(request:FastifyRequest):Promise<StaffPrincipal>{
    const raw=cookieValue(request);if(!/^[A-Za-z0-9_-]{43}$/.test(raw))throw new DomainError('UNAUTHORIZED',401);
    const row=(await this.db.query<{user_id:string;encrypted_tokens:string}>(`select user_id,encrypted_tokens from private.staff_sessions where id_hash=$1 and expires_at>now()`,[hash(raw)])).rows[0];
    if(!row)throw new DomainError('UNAUTHORIZED',401);
    let tokens:Tokens;
    try{tokens=this.decrypt(row.encrypted_tokens);}catch{throw new DomainError('UNAUTHORIZED',401);}
    if(tokens.expires_at*1000<Date.now()+30_000){
      tokens=await this.db.transaction(async db=>{
        const locked=(await db.query<{encrypted_tokens:string}>('select encrypted_tokens from private.staff_sessions where id_hash=$1 and expires_at>now() for update',[hash(raw)])).rows[0];
        if(!locked)throw new DomainError('UNAUTHORIZED',401);
        const current=this.decrypt(locked.encrypted_tokens);
        if(current.expires_at*1000>=Date.now()+30_000)return current;
        const {data,error}=await this.client().auth.refreshSession({refresh_token:current.refresh_token});
        if(error||!data.session?.expires_at)throw new DomainError('UNAUTHORIZED',401);
        const next:Tokens={access_token:data.session.access_token,refresh_token:data.session.refresh_token,expires_at:data.session.expires_at};
        await db.query('update private.staff_sessions set encrypted_tokens=$2 where id_hash=$1',[hash(raw),this.encrypt(next)]);
        return next;
      });
    }
    const {data,error}=await this.client().auth.getUser(tokens.access_token);
    if(error||data.user?.id!==row.user_id||data.user.is_anonymous)throw new DomainError('UNAUTHORIZED',401);
    return this.principal(row.user_id);
  }
  private async login(email:string,password:string,reply:FastifyReply){
    const {data,error}=await this.client().auth.signInWithPassword({email,password});
    if(error||!data.session?.expires_at||!data.user||data.user.is_anonymous)throw new DomainError('INVALID_CREDENTIALS',401);
    const user=await this.principal(data.user.id),raw=randomBytes(32).toString('base64url');
    await this.db.transaction(async db=>{
      await db.query('delete from private.staff_sessions where expires_at<=now()');
      await db.query('insert into private.staff_sessions(id_hash,user_id,encrypted_tokens,expires_at) values ($1,$2,$3,now()+interval \'12 hours\')',[
        hash(raw),user.id,this.encrypt({access_token:data.session!.access_token,refresh_token:data.session!.refresh_token,expires_at:data.session!.expires_at!})]);
    });
    this.cookie(reply,raw,43_200);return {mode:'staff',user};
  }
  private async createStaff(input:z.infer<typeof newStaff>,actorId?:string,initial=false){
    let createdUser:string|null=null;
    try{
      return await this.db.transaction(async db=>{
        await db.query('select pg_advisory_xact_lock(82910421)');
        if(initial&&(await db.query('select user_id from public.staff_members limit 1')).rows.length)throw new DomainError('SETUP_ALREADY_COMPLETE',409);
        await this.validateTherapist(db,input.role,input.therapistId);
        const {data,error}=await this.client(true).auth.admin.createUser({email:input.email,password:input.password,email_confirm:true});
        if(error||!data.user)throw new DomainError('STAFF_CREATION_FAILED',409);
        createdUser=data.user.id;
        await db.query('insert into public.staff_members(user_id,role,display_name,email) values ($1,$2,$3,$4)',[createdUser,input.role,input.name,input.email]);
        if(input.role==='therapist')await db.query('update public.therapists set staff_user_id=$2 where id=$1',[input.therapistId,createdUser]);
        await db.query('insert into private.staff_audit(actor_id,subject_id,action) values ($1,$2,$3)',[actorId??createdUser,createdUser,initial?'admin_bootstrapped':'staff_created']);
        return {id:createdUser};
      });
    }catch(error){
      // Compensate only after the SQL transaction rolls back and releases its FK locks.
      if(createdUser){try{await this.client(true).auth.admin.deleteUser(createdUser);}catch{/* Preserve the original error. */}}
      throw error;
    }
  }
  private async bootstrapNeeded(){return this.isLocal&&Boolean(this.options.bootstrapEmail)&&!(await this.db.query('select user_id from public.staff_members limit 1')).rows.length;}
  private requireAdmin(request:FastifyRequest){if(request.staff?.role!=='admin')throw new DomainError('FORBIDDEN',403);}
  register(app:FastifyInstance){
    app.get('/v1/auth/status',async()=>({mode:'staff',setupRequired:await this.bootstrapNeeded()}));
    app.post('/v1/auth/login',async(request,reply)=>{this.rateLimit(request);const input=credentials.parse(request.body);return this.login(input.email,input.password,reply);});
    app.post('/v1/auth/setup',async(request,reply)=>{
      this.rateLimit(request);const input=credentials.extend({password:z.string().min(12).max(128),name:z.string().trim().min(2).max(70)}).parse(request.body);
      if(!this.isLocal||input.email.toLowerCase()!==this.options.bootstrapEmail.toLowerCase())throw new DomainError('SETUP_NOT_ALLOWED',403);
      await this.createStaff({...input,role:'admin',therapistId:null},undefined,true);
      return this.login(input.email,input.password,reply);
    });
    app.get('/v1/auth/me',request=>({mode:'staff',user:request.staff}));
    app.post('/v1/auth/logout',async(request,reply)=>{
      const raw=cookieValue(request);
      if(raw){const row=(await this.db.query<{encrypted_tokens:string}>('delete from private.staff_sessions where id_hash=$1 returning encrypted_tokens',[hash(raw)])).rows[0];
        if(row){try{await this.client(true).auth.admin.signOut(this.decrypt(row.encrypted_tokens).access_token,'local');}catch{/* Local session was already removed. */}}}
      this.cookie(reply,'',0);return {ok:true};
    });
    app.get('/v1/staff',async request=>{this.requireAdmin(request);return {staff:(await this.db.query(`select s.user_id as id,s.display_name as name,s.email,s.role,s.active,t.id as therapist_id from public.staff_members s left join public.therapists t on t.staff_user_id=s.user_id order by s.created_at`)).rows};});
    app.post('/v1/staff',async request=>{
      this.requireAdmin(request);
      const input=newStaff.parse(request.body);
      return this.createStaff(input,request.staff!.id);
    });
    app.patch('/v1/staff/:id',async request=>{
      this.requireAdmin(request);
      const target=z.uuid().parse((request.params as {id:string}).id),input=changeStaff.parse(request.body);
      return this.db.transaction(async db=>{
        await db.query('select pg_advisory_xact_lock(82910421)');
        const existing=(await db.query('select role,active from public.staff_members where user_id=$1 for update',[target])).rows[0];
        if(!existing)throw new DomainError('STAFF_NOT_FOUND',404);
        if(existing.role==='admin'&&existing.active&&(input.role!=='admin'||!input.active)){
          const others=(await db.query("select user_id from public.staff_members where role='admin' and active and user_id<>$1",[target])).rows;
          if(!others.length)throw new DomainError('LAST_ADMIN_REQUIRED',409);
        }
        await this.validateTherapist(db,input.role,input.therapistId,target);
        await db.query('update public.therapists set staff_user_id=null where staff_user_id=$1',[target]);
        if(input.role==='therapist')await db.query('update public.therapists set staff_user_id=$2 where id=$1',[input.therapistId,target]);
        await db.query('update public.staff_members set role=$2,active=$3 where user_id=$1',[target,input.role,input.active]);
        await db.query('delete from private.staff_sessions where user_id=$1',[target]);
        await db.query("insert into private.staff_audit(actor_id,subject_id,action) values ($1,$2,'staff_updated')",[request.staff!.id,target]);
        return {ok:true};
      });
    });
  }
  private async validateTherapist(db:Sql,role:StaffRole,therapistId:string|null,userId?:string){
    if(role!=='therapist'){if(therapistId)throw new DomainError('INVALID_INPUT',400);return;}
    if(!therapistId)throw new DomainError('THERAPIST_REQUIRED',400);
    const row=(await db.query<{staff_user_id:string|null}>('select staff_user_id from public.therapists where id=$1 for update',[therapistId])).rows[0];
    if(!row||row.staff_user_id&&row.staff_user_id!==userId)throw new DomainError('THERAPIST_ALREADY_LINKED',409);
  }
}
