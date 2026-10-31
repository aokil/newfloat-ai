/** All arithmetic uses integer hundredths; API/database values retain their existing point meaning. */
export const POINT_SCALE=100;
export const MAX_POINT_VALUE=1_000_000_000;
export function pointUnits(value){
  if(typeof value!=='number'||!Number.isFinite(value))throw new RangeError('INVALID_POINT_AMOUNT');
  const text=String(value),match=/^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(text);
  if(!match)throw new RangeError('INVALID_POINT_AMOUNT');
  const absolute=BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0'));
  if(absolute>BigInt(MAX_POINT_VALUE)*100n)throw new RangeError('INVALID_POINT_AMOUNT');
  return Number(match[1]?-absolute:absolute);
}
export function pointValue(units){
  if(!Number.isSafeInteger(units)||Math.abs(units)>MAX_POINT_VALUE*POINT_SCALE)throw new RangeError('INVALID_POINT_UNITS');
  const absolute=Math.abs(units),whole=Math.floor(absolute/POINT_SCALE),fraction=String(absolute%POINT_SCALE).padStart(2,'0');
  return Number((units<0?'-':'')+whole+'.'+fraction);
}
export function availablePointUnits(user){return pointUnits(user.points_balance)-pointUnits(user.points_reserved);}
export function availablePoints(user){return pointValue(availablePointUnits(user));}
export function isPointAmount(value,{positive=false}={}){try{const units=pointUnits(value);return positive?units>0:units>=0;}catch{return false;}}
export const precisePointsRequest=req=>req?.headers?.['x-float-points-precision']==='2';
const fields=new Set(['pointsBalance','pointsReserved','pointsAvailable','pointsCharged','pointsPerCall','pointsCredited','balanceBefore','balanceAfter','delta','points','basicPointsPerUse','byokPointsPerCall']);
export function pointsResponse(value,precise){
  if(Array.isArray(value))return value.map(item=>pointsResponse(item,precise));
  if(value===null||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return value;
  const out={};let monetary=false;
  for(const [key,item] of Object.entries(value)){
    if(key==='pointsUnitScale'||key.endsWith('Units')&&fields.has(key.slice(0,-5)))continue;
    if(fields.has(key)&&typeof item==='number'){
      const units=pointUnits(item);out[key]=precise?pointValue(units):Math.trunc(units/POINT_SCALE);if(precise)out[key+'Units']=units;monetary=true;
    }else out[key]=pointsResponse(item,precise);
  }
  if(monetary&&precise)out.pointsUnitScale=POINT_SCALE;
  return out;
}
