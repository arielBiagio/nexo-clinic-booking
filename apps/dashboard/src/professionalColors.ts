/** Reuse defined, opaque colors for any number of professionals. */
export const doctorClass=(index:number)=>`doctor-${index<0?0:index%6}`;
