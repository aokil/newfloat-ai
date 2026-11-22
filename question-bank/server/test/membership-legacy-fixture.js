import {membershipAccount,membershipPlan} from '../src/membership.js';

/** Explicitly freeze the retired monthly product for compatibility-only regressions. */
export function legacyMembershipAccount(store,options){
  const members=membershipAccount(store,options);
  return {...members,fulfill:async(owner,orderId,planId)=>{
    if(!await members.offerForOrder(owner,orderId)){
      const plan=membershipPlan(planId);
      await members.freezeOffer(owner,orderId,{...plan,title:(plan.plan==='plus'?'Plus':'Go')+' 月度会员',
        billing:'monthly',permanent:false,lifetimeUpdates:false});
    }
    return members.fulfill(owner,orderId,planId);
  }};
}
