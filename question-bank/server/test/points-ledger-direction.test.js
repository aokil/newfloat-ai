import {test} from 'node:test';
import assert from 'node:assert/strict';
import {points} from '../src/account.js';
import {testApp,register,call} from './helpers.js';

test('ledger directions filter before pagination, retain owner isolation and never change balance',async t=>{
  const app=await testApp();t.after(()=>app.close());
  const a=await register(app,'ledger-owner'),b=await register(app,'other-ledger-owner');
  await app.store.transaction(async()=>{
    for(let i=0;i<35;i++){
      await points(app.store,await app.store.get('SELECT * FROM users WHERE id=?',a.principal.userId),10,null,'synthetic credit',`credit-${i}`);
      await points(app.store,await app.store.get('SELECT * FROM users WHERE id=?',a.principal.userId),-1,null,'synthetic debit',`debit-${i}`);
    }
  });
  const before=await app.store.get('SELECT points_balance,points_reserved,revision FROM users WHERE id=?',a.principal.userId);
  const foreign=new Set((await call(app,'GET','/v1/me/points-ledger',b.accessToken)).json().items.map(i=>i.id));
  const all=(await call(app,'GET','/v1/me/points-ledger?limit=200',a.accessToken)).json();
  assert.equal(all.items.length,71);assert(!Object.hasOwn(all,'direction'));
  for(const [direction,total] of [['increase',36],['decrease',35]]){
    const path=`/v1/me/points-ledger?direction=${direction}`;
    const response=await call(app,'GET',path+'&limit=5&userId='+b.principal.userId,a.accessToken);
    assert.equal(response.statusCode,200,response.body);const first=response.json();
    assert.equal(first.direction,direction);assert.equal(first.items.length,5);assert.equal(first.nextCursor,'5');
    const second=(await call(app,'GET',path+'&limit=5&cursor='+first.nextCursor,a.accessToken)).json();
    const combined=[...first.items,...second.items];assert.equal(new Set(combined.map(i=>i.id)).size,10);
    assert(combined.every(i=>(direction==='increase'?i.delta>0:i.delta<0)&&!foreign.has(i.id)));
    const complete=(await call(app,'GET',path+'&limit=200',a.accessToken)).json();
    assert.equal(complete.items.length,total);assert.equal(complete.nextCursor,null);
  }
  assert.deepEqual(await app.store.get('SELECT points_balance,points_reserved,revision FROM users WHERE id=?',a.principal.userId),before);
});

test('ledger directions reject invalid values and still require authentication',async t=>{
  const app=await testApp();t.after(()=>app.close());const session=await register(app,'ledger-filter-validation');
  assert.equal((await call(app,'GET','/v1/me/points-ledger?direction=increase',null)).statusCode,401);
  const response=await call(app,'GET','/v1/me/points-ledger?direction=invalid',session.accessToken);
  assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_REQUEST');
});
