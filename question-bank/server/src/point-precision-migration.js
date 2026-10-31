import {pointUnits} from './point-values.js';

const COLUMNS={users:['points_balance','points_reserved'],points_ledger:['delta','balance_before','balance_after'],ai_requests:['points_cost']};
const failure=code=>Object.assign(new Error(code),{code});

/** Run inside the store's migration transaction. Amounts retain the same point meaning. */
export function migrateSqlitePointPrecision(store,now=Date.now()){
  if(store.get("SELECT COUNT(*) n FROM ai_requests WHERE status='pending' AND expires_at>?",now).n)
    throw failure('POINTS_PRECISION_MIGRATION_BUSY');
  for(const [table,columns] of Object.entries(COLUMNS))for(const row of store.all(`SELECT ${columns.join(',')} FROM ${table}`))
    for(const column of columns)try{pointUnits(row[column]);}catch{throw failure('POINTS_PRECISION_DATA_INVALID');}
  for(const row of store.all("SELECT * FROM ai_requests WHERE status='pending'")){
    const user=store.get('SELECT points_reserved FROM users WHERE id=?',row.user_id);
    if(!user||pointUnits(user.points_reserved)<pointUnits(row.points_cost))throw failure('POINTS_PRECISION_DATA_INVALID');
    if(row.points_cost>0)store.run('UPDATE users SET points_reserved=ROUND(points_reserved-?,2),revision=revision+1 WHERE id=?',row.points_cost,row.user_id);
    store.run("UPDATE ai_requests SET status='failed',error_code='PROCESS_INTERRUPTED',error_message='原请求已过期，本次未扣平台点数',http_status=503,updated_at=? WHERE id=?",now,row.id);
  }
  store.db.exec('PRAGMA user_version=11;');
}

async function pointColumns(client,schema){
  return (await client.query(`SELECT table_name,column_name,data_type,numeric_precision,numeric_scale
    FROM information_schema.columns WHERE table_schema=$1 AND
    ((table_name='users' AND column_name IN ('points_balance','points_reserved')) OR
     (table_name='points_ledger' AND column_name IN ('delta','balance_before','balance_after')) OR
     (table_name='ai_requests' AND column_name='points_cost'))`,[schema])).rows;
}
export async function assertPostgresPointPrecision(client,schema){
  const columns=await pointColumns(client,schema);
  if(columns.length!==6||columns.some(c=>c.data_type!=='numeric'||Number(c.numeric_precision)!==18||Number(c.numeric_scale)!==2))
    throw failure('POINTS_PRECISION_SCHEMA_INVALID');
}
async function validatePostgresPointAmounts(client){
  for(const [table,names] of Object.entries(COLUMNS)){
    const invalid=await client.query('SELECT 1 FROM '+table+' WHERE '+names.map(name=>
      `${name} IS NULL OR ABS(${name}::numeric)>1000000000 OR ${name}::numeric<>TRUNC(${name}::numeric,2)`).join(' OR ')+' LIMIT 1');
    if(invalid.rows.length)throw failure('POINTS_PRECISION_DATA_INVALID');
  }
}
async function postgresPointSnapshot(client){
  const snapshot={};
  for(const [table,names] of Object.entries(COLUMNS)){
    snapshot[table]=(await client.query('SELECT id,'+names.map(name=>
      'CAST('+name+'::numeric*100 AS BIGINT) AS '+name).join(',')+' FROM '+table+' ORDER BY id')).rows;
  }
  return JSON.stringify(snapshot);
}
/** Repair only the known all-BIGINT drift, inside the caller's migration transaction. */
export async function ensurePostgresPointPrecision(client,schema,beforeRepair=async()=>{},now=Date.now()){
  let columns=await pointColumns(client,schema);
  const precise=items=>items.length===6&&items.every(c=>c.data_type==='numeric'&&Number(c.numeric_precision)===18&&Number(c.numeric_scale)===2);
  if(precise(columns))return {repaired:false};
  if(columns.length!==6||columns.some(c=>c.data_type!=='bigint'))throw failure('POINTS_PRECISION_SCHEMA_INVALID');
  await client.query('LOCK TABLE users,points_ledger,ai_requests IN ACCESS EXCLUSIVE MODE');
  columns=await pointColumns(client,schema);
  if(precise(columns))return {repaired:false};
  if(columns.length!==6||columns.some(c=>c.data_type!=='bigint'))throw failure('POINTS_PRECISION_SCHEMA_INVALID');
  await beforeRepair();
  if(Number((await client.query("SELECT COUNT(*) n FROM ai_requests WHERE status='pending' AND expires_at>$1",[now])).rows[0].n)>0)
    throw failure('POINTS_PRECISION_MIGRATION_BUSY');
  await validatePostgresPointAmounts(client);
  const checks=[
    'SELECT 1 FROM users WHERE points_balance<0 OR points_reserved<0 OR points_reserved>points_balance LIMIT 1',
    'SELECT 1 FROM points_ledger WHERE balance_before::numeric+delta::numeric<>balance_after::numeric OR delta=0 LIMIT 1',
    "SELECT 1 FROM ai_requests WHERE status='completed' AND result IS NOT NULL AND CASE WHEN result::jsonb->>'pointsCharged' ~ '^-?[0-9]+([.][0-9]{1,2})?$' THEN (result::jsonb->>'pointsCharged')::numeric<>points_cost::numeric ELSE TRUE END LIMIT 1"
  ];
  for(const sql of checks)if((await client.query(sql)).rows.length)throw failure('POINTS_PRECISION_DATA_INVALID');
  const before=await postgresPointSnapshot(client);
  for(const [table,names] of Object.entries(COLUMNS))
    await client.query('ALTER TABLE '+table+' '+names.map(name=>'ALTER COLUMN '+name+' TYPE NUMERIC(18,2) USING '+name+'::NUMERIC(18,2)').join(', '));
  await assertPostgresPointPrecision(client,schema);
  if(before!==await postgresPointSnapshot(client))throw failure('POINTS_PRECISION_DATA_INVALID');
  return {repaired:true};
}
export async function migratePostgresPointPrecision(client,schema,now=Date.now()){
  const columns=await pointColumns(client,schema);
  if(columns.length!==6||columns.some(c=>c.data_type!=='bigint'&&!(c.data_type==='numeric'&&Number(c.numeric_precision)===18&&Number(c.numeric_scale)===2)))
    throw failure('POINTS_PRECISION_SCHEMA_INVALID');
  const active=await client.query("SELECT COUNT(*) n FROM ai_requests WHERE status='pending' AND expires_at>$1",[now]);
  if(Number(active.rows[0].n)>0)throw failure('POINTS_PRECISION_MIGRATION_BUSY');
  await validatePostgresPointAmounts(client);
  // Only expired reservations are released; live requests must finish before this migration.
  const expired=await client.query("SELECT id,user_id,points_cost FROM ai_requests WHERE status='pending' FOR UPDATE");
  for(const row of expired.rows){
    const users=await client.query('SELECT points_reserved FROM users WHERE id=$1 FOR UPDATE',[row.user_id]);
    if(!users.rows[0]||pointUnits(users.rows[0].points_reserved)<pointUnits(row.points_cost))throw failure('POINTS_PRECISION_DATA_INVALID');
    if(row.points_cost>0)await client.query('UPDATE users SET points_reserved=ROUND(points_reserved-$1,2),revision=revision+1 WHERE id=$2',[row.points_cost,row.user_id]);
    await client.query("UPDATE ai_requests SET status='failed',error_code='PROCESS_INTERRUPTED',error_message='原请求已过期，本次未扣平台点数',http_status=503,updated_at=$1 WHERE id=$2",[now,row.id]);
  }
  for(const [table,names] of Object.entries(COLUMNS)){
    await client.query(`ALTER TABLE ${table} `+names.map(name=>`ALTER COLUMN ${name} TYPE NUMERIC(18,2) USING ${name}::NUMERIC(18,2)`).join(', '));
  }
  await assertPostgresPointPrecision(client,schema);
}
