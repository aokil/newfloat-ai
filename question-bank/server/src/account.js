import {ApiError,id} from './security.js';
import {MODEL_CATALOG,configuredCatalog,modelUnavailableReason} from './model-catalog.js';
export async function accountInfo(store,user,sessionExpires=Number.MAX_SAFE_INTEGER,now=Date.now()) {
  const available=user.points_balance-user.points_reserved;
  const allowed=!user.disabled&&available>0;
  const until=allowed?Math.min(now+900000,sessionExpires):now;
  const bindings=await configuredCatalog(store),model=MODEL_CATALOG.some(item=>!modelUnavailableReason(item,bindings.get(item.key))&&item.pointsPerCall<=available);
  return {displayName:user.display_name,avatarId:user.avatar_id??null,membership:user.membership,membershipExpiresAt:user.membership_expires===null?null:new Date(user.membership_expires).toISOString(),
    trialStartedAt:new Date(user.trial_started).toISOString(),trialEndsAt:new Date(user.trial_ends).toISOString(),
    pointsBalance:user.points_balance,pointsReserved:user.points_reserved,pointsAvailable:user.points_balance-user.points_reserved,revision:user.revision,
    entitlements:{floatingAllowed:allowed,importAllowed:allowed,aiAllowed:allowed,byokAllowed:allowed,builtinAiAllowed:allowed&&model,
      reason:user.disabled?'disabled':available>0?'points_positive':'points_empty',validUntil:new Date(until).toISOString()}};
}
export async function requirePositivePoints(store,userId){
  const user=await store.get('SELECT * FROM users WHERE id=?',userId);
  if(!user||user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
  if(user.points_balance-user.points_reserved<=0)throw new ApiError(403,'POINTS_REQUIRED','可用点数不足，暂不能开启浮窗、导入题库或调用模型');
  return user;
}
export async function userInfo(store,user) {
  return {userId:user.id,phoneNumber:user.phone_number,phoneVerified:!!user.phone_verified,displayName:user.display_name,
    registeredAt:new Date(user.created_at).toISOString(),lastLoginAt:user.last_login_at?new Date(user.last_login_at).toISOString():null,
    disabled:!!user.disabled,...await accountInfo(store,user)};
}
export async function points(store,user,delta,actor,reason,key){
  if(!Number.isSafeInteger(delta)||!delta||Math.abs(delta)>1000000000)throw new ApiError(400,'INVALID_REQUEST','点数差额须为非零安全整数且绝对值不超过10亿');
  const after=user.points_balance+delta;
  if(!Number.isSafeInteger(after)||after<user.points_reserved||after>1000000000)throw new ApiError(422,'VALIDATION_FAILED','不能扣除预留点数或超出余额预算');
  await store.run('INSERT INTO points_ledger(id,user_id,delta,balance_before,balance_after,reason,actor_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id('ledger'),user.id,delta,user.points_balance,after,reason,actor,key,Date.now());
  await store.run('UPDATE users SET points_balance=?,revision=revision+1 WHERE id=?',after,user.id);
  return after;
}
