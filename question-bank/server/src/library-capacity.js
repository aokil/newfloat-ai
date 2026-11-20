import {ApiError} from './security.js';
import {membershipAccount} from './membership.js';

/** Call inside the existing write transaction, before reading target versions/counts. */
export async function lockCloudLibraryOwner(store,owner){
  const user=await store.get('SELECT id FROM users WHERE id=?'+(store.kind==='postgres'?' FOR UPDATE':''),owner);
  if(!user)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
}

/** Only the legacy cloud-owned library is observable here. App enforces all locally held libraries. */
export async function requireCloudLibraryCapacity(store,owner,replacingBankId,nextCount){
  if(!Number.isSafeInteger(nextCount)||nextCount<0)throw new ApiError(400,'INVALID_REQUEST','题目数量无效');
  const membership=await membershipAccount(store).snapshot(owner),capacity=membership.libraryCapacity;
  const banks=await store.all('SELECT b.id,v.question_count FROM banks b LEFT JOIN private_versions v ON v.bank_id=b.id AND v.data_version=b.current_version WHERE b.owner_id=? AND b.deleted_at IS NULL',owner);
  let used=0,replaced=0;
  for(const bank of banks){
    const n=bank.question_count;
    if(!Number.isSafeInteger(n)||n<0)throw new ApiError(500,'LIBRARY_CAPACITY_UNVERIFIED','无法核对当前题库容量，请稍后重试');
    used+=n;if(bank.id===replacingBankId)replaced=n;
  }
  const next=used-replaced+nextCount;
  if(!Number.isSafeInteger(next))throw new ApiError(500,'LIBRARY_CAPACITY_UNVERIFIED','无法核对当前题库容量');
  // Downgrade never deletes existing content or blocks corrections/reductions; growth must fit the new ceiling.
  if(next>capacity&&next>used)throw new ApiError(422,'LIBRARY_CAPACITY_EXCEEDED',
    `当前账号题库收容上限${capacity}题，现有云端私人题库共${used}题，本次写入后将为${next}题，请先腾出容量或升级会员`,
    {scope:'cloud-owned',libraryCapacity:capacity,used,replaced,requested:nextCount,projected:next});
  return {libraryCapacity:capacity,used,projected:next};
}
