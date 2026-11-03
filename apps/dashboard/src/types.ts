export interface Therapist { id:string; name:string; specialty:string }
export interface StaffUser {id:string;email:string;name:string;role:'admin'|'reception'|'therapist';therapistId:string|null}
export interface Slot { id:string; therapist_id:string; starts_at:string; ends_at:string }
export interface Appointment extends Slot { patient_name:string; therapist_name:string; conversation_id:string;version:number }
export interface Conversation { id:string; status:string; patient_name:string; handoff_id:string|null; reason:string|null; preview:string; messageCount:number; created_at:string }
export interface Dashboard { clinic:{name:string;time_zone:string};therapists:Therapist[];appointments:Appointment[];slots:Slot[];conversations:Conversation[];weekStart:string;anchorDate:string }
export interface ChatMessage { id:string;role:'patient'|'assistant'|'staff';text:string;at:string }
export interface Choice { label:string;action:'start'|'more'|'select'|'confirm'|'human'|'reschedule'|'cancel'|'confirm_cancel'|'keep';slotId?:string;appointmentId?:string }
export interface PatientDetails {name:string;name_collected:boolean;phone:string|null;insurance:string|null;reported_reason:string|null;additional_info:string|null;intake_summary:string}
export interface Chat { id:string;name:string;status:string;patient:PatientDetails;messages:ChatMessage[];choices:Choice[];ai?:{provider:'openrouter'|'guided';model:string|null;error:string|null} }
export interface WorkingRule { weekday:number;startMinute:number;endMinute:number;sessionMinutes:number;bufferMinutes:number;breaks:{startMinute:number;endMinute:number}[] }
