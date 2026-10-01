import {DatabaseSync,backup} from 'node:sqlite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
const target=process.argv[2];if(!target)throw new Error('Usage: npm run backup -- <new-backup.sqlite>');
if(existsSync(target))throw new Error('Backup target must not already exist');
const db=new DatabaseSync(resolve(process.env.BANK_DATABASE||'data/bank.sqlite'),{readOnly:true});
try{await backup(db,resolve(target));process.stdout.write('Consistent SQLite backup created. Contains private data; store securely.\n');}finally{db.close();}
