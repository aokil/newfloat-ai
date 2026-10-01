// Product keys identify price tiers, never provider model IDs. A tested admin
// configuration must explicitly bind one of these keys before it is usable.
export const MODEL_CATALOG = Object.freeze([
  {key:'doubao-pro',name:'豆包 2.1 Pro',provider:'doubao',pointsPerCall:2},
  {key:'doubao-lite',name:'豆包 Lite',provider:'doubao',pointsPerCall:1},
  {key:'doubao-mini',name:'豆包 Mini',provider:'doubao',pointsPerCall:1},
  {key:'glm-5',name:'GLM 5.0',provider:'glm',pointsPerCall:2},
  {key:'glm-turbo',name:'GLM 5-Turbo',provider:'glm',pointsPerCall:2},
  {key:'glm-4-7',name:'GLM 4.7',provider:'glm',pointsPerCall:1},
  {key:'minimax-2-5',name:'MiniMax M2.5',provider:'minimax',pointsPerCall:1},
  {key:'minimax-2-7',name:'MiniMax M2.7',provider:'minimax',pointsPerCall:1},
  {key:'qwen-plus',name:'Qwen 3.5 Plus',provider:'qwen',pointsPerCall:1}
].map(item=>Object.freeze(item)));

export function catalogEntry(key) { return MODEL_CATALOG.find(item=>item.key===key); }

export function configuredCatalog(store) {
  const configured=new Map();
  for(const row of store.all('SELECT * FROM models ORDER BY created_at,id')) {
    let config;try{config=JSON.parse(row.config);}catch{continue;}
    if(!catalogEntry(config.catalogKey))continue;
    // Conflicting legacy/manual rows fail closed instead of picking a model.
    if(configured.has(config.catalogKey))configured.set(config.catalogKey,null);
    else configured.set(config.catalogKey,{row,config});
  }
  return configured;
}

export function modelUnavailableReason(item,binding) {
  if(!binding)return 'MODEL_NOT_CONFIGURED';
  const {row,config}=binding;
  if(config.provider!==item.provider||config.pointsPerCall!==item.pointsPerCall)return 'MODEL_CONFIG_MISMATCH';
  if(!row.encrypted_key)return 'MODEL_KEY_NOT_CONFIGURED';
  if(row.last_test_status!=='passed')return 'MODEL_NOT_VERIFIED';
  if(!config.enabled)return 'MODEL_DISABLED';
  return null;
}
