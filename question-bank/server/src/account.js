import {ApiError,id} from './security.js';
import {MODEL_CATALOG,configuredCatalog,modelUnavailableReason} from './model-catalog.js';
import {pointUnits,pointValue,availablePoints,availablePointUnits,MAX_POINT_VALUE} from './point-values.js';
import {pointWallet} from './point-wallet.js';
import {membershipAccount} from './membership.js';
export async function accountInfo(store,user,sessionExpires=Number.MAX_SAFE_INTEGER,now=Date.now()) {
  const membership=await membershipAccount(store).snapshot(user.id);
  user=await pointWallet(store).user(user.id);
  const available=availablePoints(user);
  const allowed=!user.disabled&&(available>0||membership.active);
  const until=allowed?Math.min(now+900000,sessionExpires):now;
  const bindings=await configuredCatalog(store),model=MODEL_CATALOG.some(item=>!modelUnavailableReason(item,bindings.get(item.key))&&item.pointsPerCall<=available);
  return {displayName:user.display_name,avatarId:user.avatar_id??null,membership:membership.plan,membershipExpiresAt:membership.expiresAt,
    membershipBenefits:{...membership,validUntil:new Date(Math.min(now+7*86400000,sessionExpires,membership.expiresAt?Date.parse(membership.expiresAt):Number.MAX_SAFE_INTEGER)).toISOString()},
    trialStartedAt:new Date(user.trial_started).toISOString(),trialEndsAt:new Date(user.trial_ends).toISOString(),
    pointsBalance:user.points_balance,pointsReserved:user.points_reserved,pointsAvailable:available,revision:user.revision,wallet:await pointWallet(store).snapshot(user.id),
    entitlements:{floatingAllowed:allowed,importAllowed:allowed,aiImportAllowed:!user.disabled&&membership.aiImports.available>0,
      aiAllowed:!user.disabled&&available>0,byokAllowed:!user.disabled&&available>0,builtinAiAllowed:!user.disabled&&available>0&&model,
      reason:user.disabled?'disabled':membership.active?'membership_active':available>0?'points_positive':'points_empty',validUntil:new Date(until).toISOString()}};
}
export async function requireImportAccess(store,userId){
  const membership=await membershipAccount(store).snapshot(userId),user=await pointWallet(store).user(userId);
  if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
  if(!membership.active&&availablePointUnits(user)<=0)throw new ApiError(403,'POINTS_REQUIRED','请补充点数或开通会员后导入题库');
  return {user,membership};
}
export async function requirePositivePoints(store,userId){
  await membershipAccount(store).snapshot(userId);
  const user=await pointWallet(store).user(userId);
  if(!user||user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
  if(availablePointUnits(user)<=0)throw new ApiError(403,'POINTS_REQUIRED','可用点数不足，暂不能开启浮窗、导入题库或调用模型');
  return user;
}
export async function userInfo(store,user) {
  return {userId:user.id,phoneNumber:user.phone_number,phoneVerified:!!user.phone_verified,displayName:user.display_name,
    registeredAt:new Date(user.created_at).toISOString(),lastLoginAt:user.last_login_at?new Date(user.last_login_at).toISOString():null,
    disabled:!!user.disabled,...await accountInfo(store,user)};
}
export async function points(store,user,delta,actor,reason,key){
  let deltaUnits;try{deltaUnits=pointUnits(delta);}catch{throw new ApiError(400,'INVALID_REQUEST','点数差额最多保留两位小数，且绝对值不超过10亿');}
  if(!deltaUnits)throw new ApiError(400,'INVALID_REQUEST','点数差额不能为零');
  return store.transaction(async()=>{
    const wallet=pointWallet(store),options={actor,reason,ledgerKey:key};
    if(deltaUnits>0)await wallet.creditPermanent(user.id,deltaUnits,key,options);
    else {
      if(pointUnits((await wallet.snapshot(user.id)).pointsAvailable)<-deltaUnits)throw new ApiError(422,'VALIDATION_FAILED','不能扣除预留点数或超出可用余额');
      await wallet.reserve(user.id,'direct:'+key,-deltaUnits);
      await wallet.capture(user.id,'direct:'+key,-deltaUnits,options);
    }
    return (await wallet.snapshot(user.id)).pointsBalance;
  });
}
