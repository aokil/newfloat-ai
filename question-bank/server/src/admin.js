import {resolve} from 'node:path';
import {Store} from './store.js';
import {phoneNumber} from './security.js';
const [command,username,option]=process.argv.slice(2);
if(!['grant','revoke','disable','enable'].includes(command)||!username)throw new Error('Usage: npm run admin -- grant|revoke|disable|enable <existing-username>. Register first; no default admin/password is created.');
if(option&&(option!=='--sponsor'||command!=='grant'))throw new Error('--sponsor is only supported with grant');
const store=new Store(resolve(process.env.BANK_DATABASE||'data/bank.sqlite'));
try {
  const user=store.get('SELECT * FROM users WHERE username=?',phoneNumber(username));if(!user)throw new Error('Account does not exist; register it through the normal API first');
  if(['disable','revoke'].includes(command)&&user.role==='admin'&&!user.disabled&&store.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n<=1)throw new Error('Cannot remove the last enabled administrator');
  store.transaction(()=>{
    if(command==='grant'||command==='revoke')store.run('UPDATE users SET role=?,revision=revision+1 WHERE id=?',command==='grant'?'admin':'user',user.id);
    else store.run('UPDATE users SET disabled=?,revision=revision+1 WHERE id=?',command==='disable'?1:0,user.id);
    store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',user.id);store.audit(null,`cli-${command}`,user.id);
    if(option==='--sponsor'&&command==='grant'){store.run("UPDATE users SET membership='sponsor',membership_expires=NULL WHERE id=?",user.id);store.audit(null,'cli-sponsor',user.id);}
  });
  process.stdout.write(`Account permission updated; previous sessions revoked.\n`);
}finally{store.close();}
