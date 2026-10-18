import {ApiError,authenticate,sha256,fields} from './security.js';
import {accountInfo,points} from './account.js';
import {safeUser,OFFLINE_MS} from './security.js';

export const CAMPAIGN_VERSION=68;
const TAG='android-v68';
const RELEASE_URL=`https://github.com/aokil/newfloat-ai/releases/tag/${TAG}`;
const METADATA_URL=`https://api.github.com/repos/aokil/newfloat-ai/releases/tags/${TAG}`;
const CAMPAIGN_KEY='android-update:v68';

/** Only explicit requests consult the public release. No timer or background poll. */
export class AndroidReleaseCampaign {
  constructor({fetchRelease=globalThis.fetch,now=()=>Date.now()}={}){
    this.fetchRelease=fetchRelease;this.now=now;this.active=null;this.pending=null;this.retryAt=0;this.lastError=false;
  }
  version(req){
    const raw=req.headers['x-float-app-version'];
    return typeof raw==='string'&&/^[1-9][0-9]{0,8}$/u.test(raw)?Number(raw):0;
  }
  async policy(){
    if(this.active)return this.active;
    if(this.pending)return this.pending;
    if(this.now()<this.retryAt){
      if(this.lastError)throw new ApiError(503,'UPDATE_POLICY_UNAVAILABLE','版本状态暂时无法核对，请稍后重试');
      return null;
    }
    this.pending=(async()=>{
      const response=await this.fetchRelease(METADATA_URL,{headers:{Accept:'application/vnd.github+json','User-Agent':'float-ai-release-policy'},redirect:'error',signal:AbortSignal.timeout(4000)});
      if(response.status===404){this.retryAt=this.now()+60_000;this.lastError=false;return null;}
      if(!response.ok)throw new Error('Release metadata unavailable');
      const raw=await response.text();if(Buffer.byteLength(raw)>128*1024)throw new Error('Release metadata oversized');
      const release=JSON.parse(raw),publishedAt=Date.parse(release.published_at);
      if(release.draft!==false||release.prerelease!==false||release.tag_name!==TAG||release.html_url!==RELEASE_URL||
        !Number.isSafeInteger(publishedAt)||publishedAt>this.now()||!release.body?.startsWith('【强制更新】')||
        !Array.isArray(release.assets)||!release.assets.some(a=>a.name==='tiyu-update.json'&&a.state==='uploaded'&&a.size>0&&a.size<=32768)||
        !release.assets.some(a=>/^tiyu-[a-f0-9]{64}\.apk$/u.test(a.name)&&a.state==='uploaded'&&a.size>0))throw new Error('Release metadata invalid');
      this.active=Object.freeze({versionCode:CAMPAIGN_VERSION,releaseUrl:RELEASE_URL,publishedAt});
      this.lastError=false;return this.active;
    })().catch(()=>{this.lastError=true;this.retryAt=this.now()+60_000;throw new ApiError(503,'UPDATE_POLICY_UNAVAILABLE','版本状态暂时无法核对，请稍后重试');})
      .finally(()=>{this.pending=null;});
    return this.pending;
  }
  async requireSupported(req,clientId){
    if(clientId!=='android'||this.version(req)>=CAMPAIGN_VERSION)return;
    const policy=await this.policy();
    if(policy)throw new ApiError(426,'APP_UPDATE_REQUIRED','本次为强制更新，请先更新到 float ai 1.0.12 后继续使用',{minimumVersionCode:CAMPAIGN_VERSION});
  }
  async claim(store,req){
    if(req.auth.client_id!=='android'||this.version(req)<CAMPAIGN_VERSION)throw new ApiError(426,'APP_UPDATE_REQUIRED','请使用新版 float ai 领取更新赠点');
    const policy=await this.policy();
    if(!policy)throw new ApiError(409,'UPDATE_NOT_RELEASED','新版尚未正式发布，请发布后重新打开应用');
    return store.transaction(async()=>{
      // A new login or account disable may race the public metadata read.
      const session=await authenticate(store,req);
      if(session.client_id!=='android')throw new ApiError(403,'FORBIDDEN','仅限新版Android应用领取');
      const existing=await store.get('SELECT result FROM confirmations WHERE owner_id=? AND idempotency_key=?',session.user_id,CAMPAIGN_KEY);
      let reward;
      if(existing){const previous=JSON.parse(existing.result);reward={...previous,status:previous.status==='not_eligible'?'not_eligible':'already_claimed'};}
      else {
        const user=await store.get('SELECT * FROM users WHERE id=?',session.user_id);
        if(user.created_at>=policy.publishedAt)reward={status:'not_eligible',basePoints:0,paidBonus:0,paidPoints:0,cutoff:new Date(policy.publishedAt).toISOString()};
        else {
          // Only real production orders with matching credited ledger rows count.
          // Gifts, sandbox orders, unpaid orders and credits after cutoff are excluded.
          const paid=await store.get("SELECT COALESCE(SUM(l.delta),0) AS total FROM points_ledger l JOIN payment_orders p ON l.idempotency_key=('alipay:' || p.id) AND l.user_id=p.owner_id WHERE l.user_id=? AND l.delta>0 AND l.delta=p.points AND p.environment='production' AND p.status='paid' AND p.paid_at<? AND l.created_at<? AND (p.error_code IS NULL OR p.error_code<>'PAYMENT_REFUND_REVIEW_REQUIRED')",user.id,policy.publishedAt,policy.publishedAt);
          const paidPoints=Number(paid.total),paidBonus=Math.floor(paidPoints/10);
          if(!Number.isSafeInteger(paidPoints)||paidPoints<0||!Number.isSafeInteger(paidBonus))throw new ApiError(503,'REWARD_CALCULATION_UNAVAILABLE','充值赠点暂时无法核对，请稍后重试');
          await points(store,user,50,null,'强制更新奖励 · 已注册用户赠送50点',CAMPAIGN_KEY+':base');
          if(paidBonus>0)await points(store,await store.get('SELECT * FROM users WHERE id=?',user.id),paidBonus,null,'强制更新奖励 · 历史充值点数10%返赠',CAMPAIGN_KEY+':paid');
          reward={status:'granted',basePoints:50,paidBonus,paidPoints,cutoff:new Date(policy.publishedAt).toISOString()};
          await store.audit(user.id,'android-update-reward',user.id,{campaign:CAMPAIGN_VERSION,basePoints:50,paidBonus,paidPoints,cutoff:policy.publishedAt});
        }
        await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',session.user_id,CAMPAIGN_KEY,sha256(CAMPAIGN_KEY),JSON.stringify(reward));
      }
      const user=await store.get('SELECT * FROM users WHERE id=?',session.user_id),now=this.now();
      return {principal:safeUser(user),account:await accountInfo(store,user,session.refresh_expires),session:{sessionId:session.id,clientId:session.client_id},
        serverTime:new Date(now).toISOString(),offlineUntil:new Date(Math.min(now+OFFLINE_MS,session.refresh_expires)).toISOString(),updateReward:reward};
    });
  }
}

export function registerAndroidReleaseCampaign(app,{store,auth,campaign}){
  app.get('/v1/app-updates/android/policy',async()=>{
    const policy=await campaign.policy();
    return policy?{mandatory:true,minimumVersionCode:policy.versionCode,releaseUrl:policy.releaseUrl,publishedAt:new Date(policy.publishedAt).toISOString()}:{mandatory:false,minimumVersionCode:0};
  });
  app.post('/v1/me/update-reward',{preHandler:auth},async req=>{fields(req.body,[]);return campaign.claim(store,req);});
}
