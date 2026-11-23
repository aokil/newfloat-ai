import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFile} from '../src/parser.js';
import {membershipPlan} from '../src/membership.js';
import {membershipAccount} from '../src/membership.js';
import {testApp,register,auth,call} from './helpers.js';

// Synthetic source rows, actual existing worker parser. No account/network/model invocation.
const table=count=>Buffer.from('题型\t题干\t答案\n'+Array.from({length:count},(_,i)=>`判断\t合成${i+1}\t对`).join('\n'));
test('parser restores original 10000 per-file ceiling independent of libraryCapacity 30000',async()=>{
  const maximum=membershipPlan('plus').importLimit;assert.equal(maximum,10000);assert.equal(membershipPlan('plus').libraryCapacity,30000);
  const result=await parseFile('synthetic-quota.tsv',table(maximum));
  assert.equal(result.items.length,maximum);assert.equal(result.items.at(-1).stem,'合成10000');
  assert.equal(result.items.flatMap(row=>row.errors).length,0);
  await assert.rejects(parseFile('synthetic-over-quota.tsv',table(maximum+1)),error=>error.code==='VALIDATION_FAILED'&&error.message.includes('10000'));
});
test('cloud previews use the original limits across legacy account records',async t=>{
  const app=await testApp();t.after(()=>app.close());const user=await register(app,'limits');
  const upload=async(count,key)=>{const boundary='limit-fixture';return app.inject({method:'POST',url:'/v1/imports',headers:{...auth(user.accessToken),'idempotency-key':key,'content-type':`multipart/form-data; boundary=${boundary}`},
    payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.tsv"\r\nContent-Type: text/tab-separated-values\r\n\r\n`),table(count),Buffer.from(`\r\n--${boundary}--\r\n`)])});};
  for(const [plan,limit,capacity]of [['free',3000,10000],['go',3000,10000],['plus',3000,10000]]){
    if(plan!=='free')await membershipAccount(app.store).fulfill(user.principal.userId,'synthetic-'+plan,plan);
    const account=(await call(app,'GET','/v1/me',user.accessToken)).json().account;assert.equal(account.membershipBenefits.importLimit,limit);assert.equal(account.membershipBenefits.libraryCapacity,capacity);
    const valid=await upload(limit,plan+'-ok');assert.equal(valid.statusCode,202);assert.equal(valid.json().status,'ready');
    const over=await upload(limit+1,plan+'-over');assert.equal(over.statusCode,202);assert.equal(over.json().status,'failed');
    assert.equal((await upload(limit,plan+'-ok')).json().importId,valid.json().importId);
  }
});
