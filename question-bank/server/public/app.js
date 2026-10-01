/* Account-scoped bank browsing. Only the current page and one index page are retained. */
window.TiyuBankBrowser = function({main, api, begin, back, principal, el, button, field, select, icon, notify, types, importBank, editBank}) {
  const order=Object.keys(types), pageSize=50, value=f=>f.input.value;
  let state=null, alive=()=>false, serial=0;
  const path=id=>'/v1/banks/'+encodeURIComponent(id);
  const owns=()=>state?.bank?.visibility==='private' && state.bank.ownerUserId===principal()?.userId;
  function active(turn){return alive() && turn===serial;}
  function groups(){return order.filter(type=>(state.bank.typeCounts?.[type]||0)>0);}
  function actionIcon(label,name,action){const b=button(label,action,'icon-button');b.replaceChildren(icon(name));b.title=label;b.setAttribute('aria-label',label);return b;}
  function shell(detail=false){
    const title=state.bank.title;
    const head=el('div',{class:'bank-reader-heading'},
      actionIcon(detail?'返回题号':'返回题库','left',detail?()=>grid(true):back),
      el('div',{},el('h1',{},title),el('p',{class:'muted'},detail?'第 '+state.item.ordinal+' 题 · '+types[state.item.questionType]:state.bank.questionCount+' 题 · '+(owns()?'私人':'公共'))));
    head.append(actionIcon(detail?'返回题卡':'导入题库',detail?'plus':'upload',detail?()=>grid(true):importBank));
    if(owns())head.append(actionIcon(detail?'编辑题目':'新增题目',detail?'edit':'plus',()=>edit(detail?state.item:null)));
    main.replaceChildren(head);
    if(!owns())main.append(el('p',{class:'hint'},'公共题库只读，通过云端更新。'));
  }
  function problem(error,retry){
    if(!alive())return;
    const conflict=error.status===409;
    main.append(el('section',{class:'reader-error',role:'alert'},
      el('p',{},conflict?'题库版本已变化，请重新载入。':error.message||'题目读取失败。'),
      button(conflict?'重新载入':'重试',conflict?()=>reload():retry)));
  }
  async function open(bankId,selectedType=null){
    alive=begin();const turn=++serial;
    state={bankId,bank:null,type:null,offset:0,items:[],item:null,selected:null,scroll:0};
    main.replaceChildren(el('p',{role:'status'},'正在读取题库…'));
    try{
      const bank=await api(path(bankId));if(!active(turn))return;
      state.bank=bank;state.type=selectedType==='choice'?groups().find(t=>['single_choice','multiple_choice'].includes(t)):groups().includes(selectedType)?selectedType:groups()[0]||null;await grid();
    }catch(error){if(active(turn)){main.replaceChildren(button('返回题库',back));problem(error,()=>open(bankId));}}
  }
  async function reload(focusId=state?.selected){
    const turn=++serial;
    try{
      const bank=await api(path(state.bankId));if(!active(turn))return;
      state.bank=bank;
      if(focusId){
        try{
          const r=await api(path(state.bankId)+'/questions/'+encodeURIComponent(focusId)+'?dataVersion='+encodeURIComponent(bank.dataVersion));
          if(!active(turn))return;
          state.type=r.item.questionType;state.offset=Math.floor((r.item.groupOrdinal-1)/pageSize)*pageSize;
          state.selected=focusId;
        }catch(error){if(!active(turn))return;if(error.status!==404)throw error;state.selected=null;}
      }
      if(!groups().includes(state.type)){state.type=groups()[0]||null;state.offset=0;}
      state.offset=Math.min(state.offset,Math.max(0,Math.ceil((bank.typeCounts[state.type]||0)/pageSize)-1)*pageSize);
      await grid();
    }catch(error){if(active(turn))problem(error,()=>reload(focusId));}
  }
  async function grid(restore=false){
    const turn=++serial;state.item=null;shell();
    main.append(el('section',{class:'float-bank-info'},el('div',{},el('h2',{},state.bank.title),owns()?actionIcon('编辑题库名称与简介','edit',()=>editBank(state.bank,()=>reload())):null),el('p',{},state.bank.description||'暂无简介'),el('small',{},'共 '+state.bank.questionCount+' 题')));
    const queryField=el('input',{type:'search',placeholder:'查找题干或选项文字','aria-label':'查找题干或选项文字'}),querySubmit=el('button',{type:'submit'},'查找'),queryForm=el('form',{class:'float-bank-search float-reader-search'},icon('search'),queryField,querySubmit),queryResult=el('div',{class:'float-reader-results','aria-live':'polite'});
    queryForm.addEventListener('submit',async event=>{
      event.preventDefault();if(querySubmit.disabled)return;const term=queryField.value.replace(/\s+/gu,'').toLocaleLowerCase();queryResult.replaceChildren();if(!term)return;querySubmit.disabled=true;queryResult.append(el('p',{class:'muted'},'正在查找当前题库…'));
      try{const found=[];let offset=0;do{const r=await api(path(state.bankId)+'/questions?'+new URLSearchParams({offset:String(offset),limit:'200',dataVersion:state.bank.dataVersion}));if(!active(turn))return;for(const q of r.items){const text=[q.stem,...(q.options||[]).map(o=>o.text)].join('\n').replace(/\s+/gu,'').toLocaleLowerCase();if(text.includes(term))found.push(q);}offset=r.nextOffset;}while(offset!==null&&offset!==undefined);if(!active(turn))return;queryResult.replaceChildren(...found.slice(0,100).map(q=>button('第 '+q.ordinal+' 题 · '+q.stem,()=>question(q.questionId),'float-reader-result')));if(!found.length)queryResult.append(el('p',{class:'muted'},'当前题库中没有包含这段文字的题目'));else queryResult.prepend(el('p',{class:'muted'},'找到 '+found.length+' 题'+(found.length>100?'，先显示前 100 题':'')));}
      catch(error){if(active(turn))notify(error.message,true);}finally{querySubmit.disabled=false;}
    });main.append(queryForm,queryResult);
    const tabs=el('div',{class:'question-groups','aria-label':'题型分组'});
    for(const type of groups()){
      const b=button(types[type]+' · '+state.bank.typeCounts[type],()=>{state.type=type;state.offset=0;state.scroll=0;return grid();},state.type===type?'selected':'');
      b.setAttribute('aria-pressed',String(state.type===type));tabs.append(b);
    }
    main.append(tabs);
    if(!state.type){main.append(el('p',{class:'muted'},'题库中还没有题目。'));return;}
    const content=el('section',{'aria-busy':'true'},el('p',{role:'status'},'正在读取题号…'));main.append(content);
    try{
      const query=new URLSearchParams({view:'index',questionType:state.type,offset:String(state.offset),limit:String(pageSize),dataVersion:state.bank.dataVersion});
      const r=await api(path(state.bankId)+'/questions?'+query);if(!active(turn))return;
      state.items=r.items;
      const numbers=el('div',{class:'question-numbers'});
      for(const q of r.items){
        const b=button(String(q.ordinal),()=>{state.scroll=window.scrollY;return question(q.questionId);},q.questionId===state.selected?'current':'');
        b.dataset.questionId=q.questionId;b.setAttribute('aria-label','第'+q.ordinal+'题，'+(q.answerComplete?'答案已核对':'答案待核对'));
        if(q.questionId===state.selected)b.setAttribute('aria-current','true');
        numbers.append(b);
      }
      const prev=button('上一页',()=>{state.offset=Math.max(0,state.offset-pageSize);return grid();});
      const next=button('下一页',()=>{state.offset=r.nextOffset;return grid();});
      prev.disabled=state.offset===0;next.disabled=r.nextOffset==null;
      content.replaceChildren(numbers,el('div',{class:'pagination'},prev,el('span',{class:'muted'},r.total?(state.offset+1)+'–'+(state.offset+r.items.length)+' / 共'+r.total+'题':'暂无题目'),next));
      content.removeAttribute('aria-busy');
      if(restore){window.scrollTo({top:state.scroll,behavior:'instant'});numbers.querySelector('[aria-current]')?.focus({preventScroll:true});}
    }catch(error){if(active(turn)){content.replaceChildren();content.removeAttribute('aria-busy');problem(error,()=>grid(restore));}}
  }
  function answerText(q){
    if(q.questionType==='true_false')return typeof q.answerBoolean==='boolean'?(q.answerBoolean?'正确':'错误'):'来源未提供答案';
    if(q.questionType==='fill_blank'&&q.answerParts?.length)return q.answerParts.map(p=>p.position+'. '+p.text).join('\n');
    if(['single_choice','multiple_choice'].includes(q.questionType)&&q.answerOptionIds?.length)
      return q.answerOptionIds.map(id=>{const o=q.options.find(o=>o.id===id);return o?id+'. '+o.text:id;}).join('\n');
    return q.answerText||'来源未提供答案';
  }
  async function question(questionId){
    const turn=++serial;state.selected=questionId;
    main.replaceChildren(button('返回题号',()=>grid(true)),el('p',{role:'status'},'正在读取题目…'));
    try{
      const r=await api(path(state.bankId)+'/questions/'+encodeURIComponent(questionId)+'?dataVersion='+encodeURIComponent(state.bank.dataVersion));
      if(!active(turn))return;state.item=r.item;state.type=r.item.questionType;
      state.offset=Math.floor((r.item.groupOrdinal-1)/pageSize)*pageSize;shell(true);
      const q=r.item;
      main.append(el('article',{class:'question-reader'},el('p',{class:'reader-stem'},q.stem),
        q.options?.length?el('ol',{class:'reader-options'},q.options.map(o=>el('li',{},el('span',{class:'option-label'},o.id+'.'),el('span',{},o.text)))):null,
        el('section',{class:'reader-answer'},el('h2',{},q.answerComplete?'正确答案':'答案待核对'),el('div',{class:'pre'},answerText(q))),
        el('section',{class:'reader-explanation'},el('h2',{},'解析'),el('div',{class:'pre'},q.explanation||'暂无解析')),
        q.sourceName?el('p',{class:'muted pre'},'来源：'+q.sourceName):null));
      const available=groups(), groupIndex=available.indexOf(q.questionType);
      const prev=button('上一题',()=>adjacent(-1),'secondary'),next=button('下一题',()=>adjacent(1),'primary');
      prev.disabled=groupIndex===0&&q.groupOrdinal===1;
      next.disabled=groupIndex===available.length-1&&q.groupOrdinal===state.bank.typeCounts[q.questionType];
      main.append(el('div',{class:'question-pager'},prev,el('span',{class:'muted'},q.groupOrdinal+' / '+state.bank.typeCounts[q.questionType]),next));
      window.scrollTo({top:0,behavior:'instant'});main.focus({preventScroll:true});
    }catch(error){if(active(turn))problem(error,()=>question(questionId));}
  }
  async function adjacent(direction){
    const q=state.item, available=groups();let type=q.questionType,position=q.groupOrdinal+direction;
    if(position<1){type=available[available.indexOf(type)-1];position=state.bank.typeCounts[type];}
    else if(position>state.bank.typeCounts[type]){type=available[available.indexOf(type)+1];position=1;}
    if(!type)return;
    const turn=++serial;
    const query=new URLSearchParams({view:'index',questionType:type,offset:String(position-1),limit:'1',dataVersion:state.bank.dataVersion});
    try{const r=await api(path(state.bankId)+'/questions?'+query);if(active(turn)&&r.items[0])await question(r.items[0].questionId);}
    catch(error){if(active(turn))problem(error,()=>adjacent(direction));}
  }
  function edit(existing){
    if(!owns())return;
    const q=existing||{questionType:state.type||'single_choice',options:[],answerOptionIds:[],answerComplete:false};
    const version=state.bank.dataVersion, id=state.bankId, savedAlive=alive, key=crypto.randomUUID();
    const type=select('题型',types,q.questionType),stem=field('题干','textarea',q.stem||'');
    const options=field('选项','textarea',(q.options||[]).map(o=>o.id+'. '+o.text).join('\n'),'每行一个，如 A. 选项内容');
    const correct=field('正确选项','text',(q.answerOptionIds||[]).join('、'),'多个选项用顿号分隔');
    const bool=select('判断答案',{'':'未填写',true:'正确',false:'错误'},typeof q.answerBoolean==='boolean'?String(q.answerBoolean):'');
    const parts=field('各空答案','textarea',(q.answerParts||[]).map(p=>p.text).join('\n'),'按空位顺序，每行一个');
    const count=field('原题空位数','number',q.expectedBlankCount??'');
    const answer=field('答案','textarea',q.answerText||''), explanation=field('解析','textarea',q.explanation||'');
    const source=field('来源','text',q.sourceName||''),complete=el('input',{type:'checkbox',checked:q.answerComplete===true});
    const error=el('p',{class:'error-text',role:'alert'}),submit=el('button',{type:'submit',class:'primary'},existing?'保存修改':'新增题目');
    const editorTitle=el('h2',{tabindex:'-1',id:'bank-editor-title'},existing?'编辑第 '+existing.ordinal+' 题':'新增题目');
    const form=el('form',{},editorTitle,el('p',{class:'muted'},state.bank.title+' · 仅本人及管理员可见'),type.node,stem.node,options.node,correct.node,bool.node,parts.node,count.node,answer.node,explanation.node,source.node,el('label',{class:'check'},complete,'答案已核对'),error);
    const box=el('dialog',{class:'question-editor','aria-labelledby':'bank-editor-title'},el('div',{class:'dialogbody'},form));let dirty=false,busy=false;
    function visibility(){
      const t=value(type),choice=['single_choice','multiple_choice'].includes(t);
      options.node.hidden=!choice;correct.node.hidden=!choice;bool.node.hidden=t!=='true_false';
      parts.node.hidden=count.node.hidden=t!=='fill_blank';answer.node.hidden=!['short_answer','unknown'].includes(t);
    }
    visibility();type.input.addEventListener('change',visibility);
    form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});
    function cancel(){if(!busy&&(!dirty||window.confirm('放弃未保存的修改？')))box.close();}
    form.append(el('div',{class:'dialogactions'},button('取消',cancel),submit));
    box.addEventListener('cancel',event=>{event.preventDefault();cancel();});
    box.addEventListener('close',()=>box.remove());
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!savedAlive())return;error.textContent='';
      try{
        const t=value(type),data={questionType:t,stem:value(stem),options:[],answerText:'',answerOptionIds:[],answerComplete:complete.checked,explanation:value(explanation),sourceName:value(source)};
        if(!data.stem.trim())throw Error('请填写题干');
        if(['single_choice','multiple_choice'].includes(t)){
          data.options=value(options).split('\n').filter(x=>x.trim()).map(line=>{const m=line.match(/^\s*([^\.．、)）\s]+)[.．、)）]\s*(.+)$/u);if(!m)throw Error('选项格式应为 A. 选项内容');return{id:m[1],text:m[2]};});
          data.answerOptionIds=value(correct).trim().split(/[,，、;；\s]+/u).filter(Boolean);
          if(data.answerOptionIds.length===1&&/^[A-Z]{2,}$/u.test(data.answerOptionIds[0])&&[...data.answerOptionIds[0]].every(id=>data.options.some(o=>o.id===id)))data.answerOptionIds=[...data.answerOptionIds[0]];
          data.answerText=data.answerOptionIds.map(id=>{const o=data.options.find(o=>o.id===id);if(!o)throw Error('正确选项不存在：'+id);return o.text;}).join('\n');
        }else if(t==='true_false'){if(value(bool)!==''){data.answerBoolean=value(bool)==='true';data.answerText=data.answerBoolean?'正确':'错误';}}
        else if(t==='fill_blank'){
          data.answerParts=value(parts).split('\n').filter(x=>x.trim()).map((text,i)=>({position:i+1,text:text.trim()}));
          if(value(count)!==''){data.expectedBlankCount=Number(value(count));if(!Number.isSafeInteger(data.expectedBlankCount)||data.expectedBlankCount<1)throw Error('空位数须为正整数');}
          data.answerText=data.answerParts.length===1?data.answerParts[0].text:data.answerParts.map(p=>p.position+'. '+p.text).join('\n');
        }else data.answerText=value(answer);
        busy=true;form.querySelectorAll('input,textarea,select,button').forEach(n=>{n.disabled=true;});submit.textContent='正在保存…';
        const r=await api(path(id)+'/questions'+(existing?'/'+encodeURIComponent(existing.questionId):''),{method:existing?'PATCH':'POST',key,body:{expectedBankVersion:version,question:data}});
        dirty=false;box.close();if(!savedAlive())return;notify('已保存到个人题库');
        state.selected=r.item.questionId;await reload(r.item.questionId);
        if(savedAlive()&&state.bank.dataVersion===r.dataVersion)await question(r.item.questionId);
      }catch(e){if(box.isConnected){error.textContent=e.status===409?'题库已在其他位置更新。当前输入已保留，请取消后刷新题库，再核对修改。':e.message;error.tabIndex=-1;error.focus();}}
      finally{busy=false;if(box.isConnected){form.querySelectorAll('input,textarea,select,button').forEach(n=>{n.disabled=false;});submit.textContent=existing?'保存修改':'新增题目';}}
    });
    document.body.append(box);box.showModal();editorTitle.focus({preventScroll:true});box.scrollTop=0;
  }
  return {open};
};

/* Same-origin web client. Credentials and tokens live only in memory. */
(()=>{
'use strict';
const $=id=>document.getElementById(id), main=$('main'), shell=$('shell');
let session=null, epoch=0, pageNumber=0, currentPage='banks', refreshFlight=null, nav=null;
let authView=0, authCooldown=null, authScene=null;
const date=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const types={single_choice:'单选题',multiple_choice:'多选题',true_false:'判断题',fill_blank:'填空题',short_answer:'简答题',unknown:'未确定'};
const states={ready:'待确认',needs_review:'需要纠错',confirmed:'已入库',failed:'解析失败',processing:'解析中',uploaded:'已上传',published:'已发布',withdrawn:'已撤回',draft:'草稿',passed:'测试通过',not_tested:'未测试',uncertain:'结果待核对'};
function el(tag,attrs={},...children){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(v==null)continue;if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(k==='checked')n.checked=!!v;else n.setAttribute(k,String(v));}for(const c of children.flat()){if(c!=null)n.append(c instanceof Node?c:document.createTextNode(String(c)));}return n;}

const iconPaths={
 phone:['M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z','M10 5h4','M11 19h2'],
 lock:['M5 10h14v11H5Z','M8 10V7a4 4 0 0 1 8 0v3','M12 14v3'],
 eye:['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z','M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0'],
 eyeOff:['M3 3l18 18','M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a20 20 0 0 1-3.1 3.9','M6.2 6.2A23 23 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.8-1.8','M10 10a3 3 0 0 0 4 4'],
 library:['M5 4h11a2 2 0 0 1 2 2v14H7a3 3 0 0 1-3-3V5a1 1 0 0 1 1-1Z','M4 17a3 3 0 0 1 3-3h11','M8 8h6'],
 bell:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9','M10 21h4'],
 user:['M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0','M4 21v-2a8 8 0 0 1 16 0v2'],
 shield:['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z','m8 12 3 3 5-6'],
 plus:['M12 5v14','M5 12h14'],refresh:['M20 7V3l-3 3a8 8 0 1 0 3 10','M20 7h-4'],
 download:['M12 3v12','m7 10 5 5 5-5','M4 16v5h16v-5'],edit:['m4 16 12-12 4 4L8 20H4v-4Z'],
 close:['m6 6 12 12','M18 6 6 18'],left:['m15 5-7 7 7 7'],right:['m9 5 7 7-7 7'],
 more:['M5 12h.01M12 12h.01M19 12h.01'],logout:['M9 4H4v16h5','M10 12h11','m17 8 4 4-4 4'],
 points:['M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0','M12 7v10','M9 9h5a2 2 0 0 1 0 4h-4'],
 upload:['M12 16V3','m7 8 5-5 5 5','M4 16v5h16v-5'],search:['M3 10a7 7 0 1 0 14 0 7 7 0 1 0-14 0','m15 15 6 6']
};
function icon(name){
  const aliases={left:'arrow-left',right:'chevron-right',refresh:'refresh-cw',phone:'smartphone',eyeOff:'eye-off',more:'ellipsis',points:'coins',upload:'arrow-up-from-line',bell:'megaphone',close:'x',user:'user-round',edit:'pencil',logout:'log-out'};
  const nodes=window.FloatUIAssets?.icons[aliases[name]||name];
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const[k,v]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'icon'}))svg.setAttribute(k,v);
  if(nodes){for(const[tag,attrs]of nodes){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);svg.append(n);}}
  else for(const d of iconPaths[name]||[]){const n=document.createElementNS('http://www.w3.org/2000/svg','path');n.setAttribute('d',d);svg.append(n);}
  return svg;
}
const iconLabels={'搜题':'scan-text','题库':'library','公告':'bell','我的':'user','管理':'shield','导入新题库':'plus','添加模型':'plus','新建公告':'plus','刷新列表':'refresh','下载原件':'download','编辑':'edit','关闭':'close','上一页':'left','下一页':'right','搜索':'search','查看题目':'right','点数明细':'points','退出':'logout','账户':'user'};
const iconOnly=new Set(['刷新列表','下载原件','编辑','关闭','上一页','下一页','账户']);
function button(label,action,cls=''){const b=el('button',{type:'button',class:cls+(iconOnly.has(label)?' icon-button':''),title:iconOnly.has(label)?label:null,'aria-label':iconOnly.has(label)?label:null},iconLabels[label]?icon(iconLabels[label]):null,el('span',{class:iconOnly.has(label)?'sr-only':''},label));b.addEventListener('click',async()=>{if(b.disabled||b.dataset.busy)return;b.dataset.busy='true';b.classList.add('is-busy');b.setAttribute('aria-disabled','true');b.setAttribute('aria-busy','true');try{await perform(action);}finally{delete b.dataset.busy;b.classList.remove('is-busy');b.removeAttribute('aria-disabled');b.removeAttribute('aria-busy');}});return b;}

const pill=(text,kind='')=>el('span',{class:'pill '+kind},text);
let noticeTimer=null;
function notify(message,error=false){clearTimeout(noticeTimer);$('notice').textContent=message||'';$('notice').className=error?'error':'';if(message)noticeTimer=setTimeout(()=>{if($('notice').textContent===message)$('notice').textContent='';},3000);}
function fail(error){notify(error?.message||'操作失败，请稍后重试',true);}
async function perform(action){notify('');try{await action();}catch(e){fail(e);}}
let fieldSequence=0;
function field(label,type='text',value='',hint=''){const id='field-'+(++fieldSequence),input=type==='textarea'?el('textarea',{id}):el('input',{type,id});input.value=value??'';if(hint)input.setAttribute('aria-describedby',id+'-hint');const labelNode=el('label',{class:'field',for:id},el('span',{},label),input);return{input,node:el('div',{},labelNode,hint?el('p',{class:'hint',id:id+'-hint'},hint):null)};}
function showFormError(node,message){node.textContent=message;node.tabIndex=-1;node.focus();}
function select(label,options,value){const input=el('select',{'aria-label':label},Object.entries(options).map(([v,t])=>el('option',{value:v},t)));input.value=value;return{input,node:el('label',{class:'field'},el('span',{},label),input)};}
const inputValue=f=>f.input.value;
function number(f){if(!inputValue(f).trim())throw Error('请填写整数');const n=Number(inputValue(f));if(!Number.isSafeInteger(n))throw Error('请填写整数');return n;}
function table(headers,rows){return el('div',{class:'tablewrap'},el('table',{role:'table'},el('thead',{role:'rowgroup'},el('tr',{role:'row'},headers.map(h=>el('th',{scope:'col',role:'columnheader'},h)))),el('tbody',{role:'rowgroup'},rows.length?rows.map(cells=>el('tr',{role:'row'},cells.map((c,i)=>el('td',{role:'cell','data-label':headers[i]},el('span',{class:'cell-label','aria-hidden':'true'},headers[i]),el('div',{class:'cell-value'},c))))):el('tr',{role:'row'},el('td',{colspan:headers.length,class:'empty',role:'cell'},'暂无记录')))));}
function actions(...buttons){if(buttons.length<=2)return el('div',{class:'row actions'},buttons);const more=el('details',{class:'action-menu'},el('summary',{'aria-label':'更多操作',title:'更多操作'},icon('more')),el('div',{class:'menu-items'},buttons.slice(2)));return el('div',{class:'row actions'},buttons.slice(0,2),more);}
function heading(title,description){main.replaceChildren(el('div',{class:'page-heading'},el('div',{},el('h1',{},title),description?el('p',{class:'muted'},description):null)));}
function dialog(title,fields,submitLabel,onSubmit){const operationKey=crypto.randomUUID();const error=el('p',{class:'error-text',role:'alert'}),form=el('form',{},el('h2',{},title),fields,error);const box=el('dialog',{},el('div',{class:'dialogbody'},form));const submit=el('button',{type:'submit',class:'primary'},submitLabel);form.append(el('div',{class:'dialogactions'},button('取消',()=>box.close()),submit));form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;submit.classList.add('is-busy');error.textContent='';try{await onSubmit(operationKey);box.close();}catch(e){showFormError(error,e.message);}finally{submit.disabled=false;submit.classList.remove('is-busy');}});box.addEventListener('close',()=>box.remove());document.body.append(box);box.showModal();return box;}
function readDialog(title,content){const box=el('dialog',{},el('div',{class:'dialogbody'},el('h2',{},title),content,el('div',{class:'dialogactions'},button('关闭',()=>box.close()))));box.addEventListener('close',()=>box.remove());document.body.append(box);box.showModal();}
function clearSession(){web.reset();epoch++;$('subnav').replaceChildren();shell.classList.add('signed-out');session=null;refreshFlight=null;document.querySelectorAll('dialog').forEach(d=>d.close());if(nav){nav.remove();nav=null;}$('account').replaceChildren();loginPage(false,'',false);}
async function raw(path,{method='GET',body,token,key}={}){if(!path.startsWith('/v1/'))throw Error('接口地址无效');const headers={Accept:'application/json'};if(token)headers.Authorization='Bearer '+token;if(key)headers['Idempotency-Key']=key;const multipart=body instanceof FormData;if(body!==undefined&&!multipart)headers['Content-Type']='application/json';let response;try{response=await fetch(path,{method,headers,body:body===undefined?undefined:multipart?body:JSON.stringify(body),cache:'no-store',credentials:'omit',redirect:'error'});}catch{throw Error('连接失败；若已提交修改，请刷新核对结果后再重试。');}let data={};if(response.status!==204){try{data=await response.json();}catch{throw Error('服务返回了无法读取的结果，请重新检查连接。');}}if(!response.ok){const e=Error(data.error?.message||'服务请求失败');e.code=data.error?.code;e.status=response.status;e.recoveryAvailable=data.error?.recoveryAvailable===true;throw e;}return data;}
async function refresh(savedEpoch,attempted){if(!session||epoch!==savedEpoch)throw Error('账号已切换，请重新操作');if(session.accessToken!==attempted)return;if(!refreshFlight){const token=session.refreshToken;refreshFlight=(async()=>{try{const next=await raw('/v1/auth/refresh',{method:'POST',body:{refreshToken:token,clientId:'web'}});if(epoch!==savedEpoch)throw Error('账号已切换');session=next;accountHeader();}catch(e){if(epoch===savedEpoch)clearSession();throw e;}finally{refreshFlight=null;}})();}await refreshFlight;}
async function api(path,{method='GET',body,key}={}){if(!session)throw Error('请先登录');const savedEpoch=epoch,token=session.accessToken;const retrySafe=method==='GET'||!!key;let result;try{result=await raw(path,{method,body,key,token});}catch(e){if(epoch!==savedEpoch)throw Error('账号已切换，请重新操作');if(e.status===401&&retrySafe){if(refreshFlight)await refreshFlight;if(session&&session.accessToken!==token)result=await raw(path,{method,body,key,token:session.accessToken});else if(e.code==='ACCESS_EXPIRED'){await refresh(savedEpoch,token);result=await raw(path,{method,body,key,token:session.accessToken});}else{clearSession();throw e;}}else{if(e.code==='ACCOUNT_DISABLED'||e.code==='SESSION_REVOKED')clearSession();throw e;}}if(epoch!==savedEpoch)throw Error('账号已切换，请重新操作');return result;}
const mutation=(path,body,method='POST',key=crypto.randomUUID())=>api(path,{method,body,key});
function accountHeader(){if(!session)return;const a=session.account||{};const accountButton=button('账户',()=>show('profile'),'account-button');accountButton.title=session.principal.phoneNumber||session.principal.username;$('account').replaceChildren(el('span',{class:'balance-mini'},`${a.pointsAvailable??0} 点`),accountButton);}
async function updateMe(){const me=await api('/v1/me');session={...session,...me};accountHeader();}
function signedIn(next){disposeAuthScene();shell.classList.remove('signed-out');epoch++;session=next;web.loadPreferences();accountHeader();buildNav();void perform(async()=>{await show('banks');const saved=epoch;const data=await api('/v1/announcements');if(saved!==epoch||!data.items.length)return;const a=data.items[0];let box;box=dialog(a.title,[el('div',{class:'pre'},a.body),el('p',{class:'muted'},'')],'此版本不再提醒',async()=>{await api(`/v1/announcements/${a.id}/dismiss`,{method:'POST',body:{version:a.version}});notify('已设置当前版本不再提醒');});});}
function buildNav(){nav?.remove();nav=el('nav',{'aria-label':'主导航',class:'main-nav'});const links=[['search','搜题'],['banks','题库'],['profile','我的']];if(session.principal.roles.includes('admin'))links.push(['users','管理']);for(const[key,label]of links){const b=button(label,()=>show(key));b.dataset.page=key;nav.append(b);}shell.prepend(nav);}
function sectionFor(name){return ['users','review','releases','models','manageAnnouncements','audit'].includes(name)?'users':['banks','imports'].includes(name)?'banks':['search','userModels','modelSettings','byok'].includes(name)?'search':'profile';}
function secondaryNav(name){const group=sectionFor(name);const groups={banks:[],search:[],users:[['users','用户管理'],['review','题库审核'],['releases','发布记录'],['models','AI 模型'],['manageAnnouncements','公告管理'],['audit','操作日志']],profile:[]};const links=groups[group]||[];const tabs=links.map(([key,label])=>{const b=button(label,()=>show(key),name===key?'selected':'');b.dataset.page=key;if(name===key)b.setAttribute('aria-current','page');return b;});$('subnav').className=group==='users'?'admin-subnav':'';if(group==='users'){const picker=select('管理分区',Object.fromEntries(links),name);picker.node.classList.add('subnav-select');picker.input.addEventListener('change',()=>{const page=picker.input.value;void perform(()=>show(page));});tabs.push(picker.node);}$('subnav').replaceChildren(...tabs);document.querySelectorAll('.main-nav button').forEach(b=>{b.classList.toggle('selected',b.dataset.page===group);if(b.dataset.page===group)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});}
async function signOut(){const old=session;clearSession();try{await raw('/v1/auth/logout',{method:'POST',body:{refreshToken:old.refreshToken,clientId:'web'}});}finally{notify('已退出');}}
function disposeAuthScene(){authScene?.dispose();authScene=null;document.body.classList.remove('auth-screen');}
function createAuthScene(){
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const letters=['F','l','o','a','t',' ','a','i'];
  const wordmark=()=>el('span',{class:'auth-wordmark',role:'img','aria-label':'Float ai'},...letters.map((letter,index)=>el('span',{class:letter===' '?'auth-word-space':`auth-letter auth-letter-${index+1}`,'aria-hidden':'true'},letter)));
  const lockup=()=>el('div',{class:'auth-lockup'},wordmark(),el('span',{class:'auth-tagline'},'一键式搜题助手'));
  const bubbles=el('div',{class:'auth-bubbles','aria-hidden':'true'},...Array.from({length:12},(_,index)=>el('span',{class:`auth-bubble auth-bubble-${index+1}`})));
  const hero=el('div',{class:'auth-hero'},lockup());
  const brand=el('div',{class:'auth-brand'},lockup());
  const content=el('div',{class:'auth-content'});
  const scene=el('section',{class:'auth-scene','aria-label':'Float ai 登录'},bubbles,hero,brand,content);
  let destroyed=false;
  function updateMotion(){
    if(destroyed)return;
    const paused=motion.matches||document.hidden;
    scene.classList.toggle('auth-paused',paused);
  }
  const motionChanged=()=>updateMotion();
  const pageHidden=()=>scene.classList.add('auth-paused');
  document.addEventListener('visibilitychange',updateMotion);window.addEventListener('pagehide',pageHidden);window.addEventListener('pageshow',updateMotion);motion.addEventListener('change',motionChanged);
  main.replaceChildren(scene);
  updateMotion();
  return {content,setExpanded(value){scene.classList.toggle('auth-expanded',value);},dispose(){destroyed=true;document.removeEventListener('visibilitychange',updateMotion);window.removeEventListener('pagehide',pageHidden);window.removeEventListener('pageshow',updateMotion);motion.removeEventListener('change',motionChanged);scene.remove();}};
}
function authPage(expanded=true){clearInterval(authCooldown);authCooldown=null;const view=++authView;document.body.classList.add('auth-screen');shell.classList.add('signed-out');authScene??=createAuthScene();authScene.content.replaceChildren();authScene.setExpanded(expanded);return()=>authView===view&&!session;}
function phoneField(value=''){const f=field('手机号','tel',value);f.input.autocomplete='username';f.input.inputMode='tel';f.input.required=true;return f;}
function passwordField(label,newPassword=false){const f=field(label,'password','',newPassword?'至少6个字符':'');f.input.autocomplete=newPassword?'new-password':'current-password';f.input.required=true;f.input.minLength=newPassword?6:1;f.input.maxLength=newPassword?64:128;return f;}
function verificationField(){const f=field('短信验证码','text');f.input.autocomplete='one-time-code';f.input.inputMode='numeric';f.input.maxLength=6;f.input.pattern='[0-9]{6}';f.input.required=true;return f;}
function validNewPassword(value,confirmation){if(value.length<6||value.length>64)throw Error('密码长度不符合要求');if(value!==confirmation)throw Error('两次密码不一致');}
function makeSmsButton(path,phone,alive,onChallenge,error,phoneRevision){
  const send=button('发送验证码',async()=>{if(phone.input.disabled||!phone.input.reportValidity())return;const username=inputValue(phone),revision=phoneRevision();send.disabled=true;send.dataset.sending='true';error.textContent='';
    try{const data=await raw(path,{method:'POST',body:{username}});if(!alive())return;
      const current=revision===phoneRevision()&&username===inputValue(phone);if(current)onChallenge({...data,phone:username});
      let seconds=Math.max(1,Math.min(3600,data.retryAfterSeconds||60));send.dataset.cooldownUntil=String(Date.now()+seconds*1000);send.textContent=`${seconds} 秒后重发`;clearInterval(authCooldown);
      authCooldown=setInterval(()=>{if(!alive()){clearInterval(authCooldown);return;}seconds--;send.textContent=seconds>0?`${seconds} 秒后重发`:'发送验证码';if(seconds<=0){clearInterval(authCooldown);delete send.dataset.cooldownUntil;send.disabled=phone.input.disabled;}},1000);
      notify(current?'验证码已发送':'手机号已更改，请为当前号码重新获取验证码');
    }catch(e){if(alive()){send.disabled=phone.input.disabled;showFormError(error,e.message);}}finally{delete send.dataset.sending;}
  });return send;
}
function authLineField(f,name,prompt){
  const hint=f.node.querySelector('.hint');
  const label=el('label',{for:f.input.id,class:'auth-field-label'},prompt);
  f.input.placeholder=' ';
  const line=el('div',{class:'auth-line'},icon(name),f.input,label);
  if(f.input.type==='password'){
    const toggle=el('button',{type:'button',class:'auth-password-toggle','aria-label':'显示密码','aria-pressed':'false',title:'显示密码'},icon('eyeOff'));
    toggle.addEventListener('click',()=>{const visible=f.input.type==='password';f.input.type=visible?'text':'password';toggle.replaceChildren(icon(visible?'eye':'eyeOff'));toggle.setAttribute('aria-label',visible?'隐藏密码':'显示密码');toggle.title=visible?'隐藏密码':'显示密码';toggle.setAttribute('aria-pressed',String(visible));});line.append(toggle);
  }
  f.node=el('div',{class:'auth-field'},line,hint);return f;
}
function authCard(title,...content){return el('section',{class:'auth-panel','aria-labelledby':'auth-title'},el('h1',{id:'auth-title',tabindex:'-1',class:title==='登录 Float ai'?'sr-only':''},title),...content);}
function authClose(phone,returnToLogin=false){const label=returnToLogin?'返回登录':'收起登录',close=el('button',{type:'button',class:'auth-close icon-button','aria-label':label,title:label},icon('close'));close.addEventListener('click',()=>{loginPage(false,inputValue(phone),returnToLogin);if(!returnToLogin)authScene.content.querySelector('.auth-entry')?.focus({preventScroll:true});});return close;}
function lockAuthForm(form,submit,busy){for(const input of form.querySelectorAll('input'))input.disabled=busy;for(const b of (form.closest('.auth-panel')||form).querySelectorAll('button'))b.disabled=busy||b.dataset.sending==='true'||Number(b.dataset.cooldownUntil||0)>Date.now();const close=authScene.content.querySelector('.auth-close');if(close)close.disabled=busy;submit.classList.toggle('is-busy',busy);form.setAttribute('aria-busy',String(busy));}
function loginPage(register=false,username='',expanded=true){
  const alive=authPage(expanded),phone=authLineField(phoneField(username),'phone','请输入手机号'),password=authLineField(passwordField('密码',register),'lock','请输入密码'),confirmation=authLineField(passwordField('确认密码',true),'lock','确认密码'),code=authLineField(verificationField(),'shield','短信验证码');let challenge=null,phoneRevision=0;
  // Repeat-password fields share validation, without repeating the instruction.
  confirmation.node.querySelector('.hint')?.remove();confirmation.input.removeAttribute('aria-describedby');
  const err=el('p',{class:'error-text',role:'alert'}),recovery=button('忘记密码？',()=>resetPasswordPage(inputValue(phone)),'auth-link');
  const send=makeSmsButton('/v1/auth/registration-code',phone,alive,value=>challenge=value,err,()=>phoneRevision);
  phone.input.addEventListener('input',()=>{phoneRevision++;challenge=null;err.textContent='';});
  const submit=el('button',{type:'submit',class:'auth-submit full'},register?'注册并进入':'登录');
  const form=el('form',{},phone.node,password.node,register?[confirmation.node,el('div',{class:'sms-row'},code.node,send)]:[],err,submit,el('div',{class:'auth-links'},register?button('返回登录',()=>loginPage(false,inputValue(phone)),'auth-link'):[button('注册',()=>loginPage(true,inputValue(phone)),'auth-link'),recovery]));
  form.addEventListener('submit',async event=>{event.preventDefault();if(submit.disabled)return;err.textContent='';lockAuthForm(form,submit,true);
    try{const username=inputValue(phone),body={username,password:inputValue(password),clientId:'web'};
      if(register){validNewPassword(body.password,inputValue(confirmation));if(send.dataset.sending==='true')throw Error('验证码正在发送，请稍候');if(!challenge||challenge.phone!==username)throw Error('请为当前手机号获取验证码');Object.assign(body,{passwordConfirmation:inputValue(confirmation),verificationCode:inputValue(code),challengeId:challenge.challengeId});}
      const next=await raw('/v1/auth/'+(register?'register':'login'),{method:'POST',body});if(!alive())return;
      password.input.value='';confirmation.input.value='';code.input.value='';clearInterval(authCooldown);authView++;notify(register?'注册成功，已获赠10点并开启15分钟试用':'登录成功');signedIn(next);
    }catch(e){if(alive())showFormError(err,e.message);}
    finally{if(alive())lockAuthForm(form,submit,false);}
  });
  const card=authCard(register?'创建账号':'登录 Float ai',register?el('p',{class:'muted'},'15分钟全功能试用 · 赠送10点'):null,form),close=authClose(phone,register);card.hidden=!expanded;close.hidden=!expanded;
  const entry=el('button',{type:'button',class:'auth-entry','aria-expanded':String(expanded),'aria-controls':'auth-panel'},icon('phone'),'手机号登录');card.id='auth-panel';entry.hidden=expanded;
  entry.addEventListener('click',()=>{entry.hidden=true;entry.setAttribute('aria-expanded','true');card.hidden=false;close.hidden=false;authScene.setExpanded(true);close.focus({preventScroll:true});});
  card.addEventListener('keydown',event=>{if(event.key==='Escape'&&!submit.disabled){event.preventDefault();close.click();}});
  authScene.content.append(entry,close,card);if(expanded)card.querySelector('h1').focus({preventScroll:true});
}
function resetPasswordPage(username){
  const alive=authPage(),phone=authLineField(phoneField(username),'phone','请输入手机号'),code=authLineField(verificationField(),'shield','短信验证码'),password=authLineField(passwordField('新密码',true),'lock','新密码'),confirmation=authLineField(passwordField('确认新密码',true),'lock','确认新密码');let challenge=null,phoneRevision=0;
  confirmation.node.querySelector('.hint')?.remove();confirmation.input.removeAttribute('aria-describedby');
  const err=el('p',{class:'error-text',role:'alert'}),send=makeSmsButton('/v1/auth/password-reset-code',phone,alive,value=>challenge=value,err,()=>phoneRevision);
  phone.input.addEventListener('input',()=>{phoneRevision++;challenge=null;code.input.value='';err.textContent='';});
  const submit=el('button',{type:'submit',class:'auth-submit full'},'重设密码');
  const form=el('form',{},phone.node,el('div',{class:'sms-row'},code.node,send),password.node,confirmation.node,err,submit,el('div',{class:'auth-links'},button('返回登录',()=>loginPage(false,inputValue(phone)),'auth-link')));
  form.addEventListener('submit',async event=>{event.preventDefault();if(submit.disabled)return;err.textContent='';lockAuthForm(form,submit,true);
    try{const username=inputValue(phone);validNewPassword(inputValue(password),inputValue(confirmation));if(send.dataset.sending==='true')throw Error('验证码正在发送，请稍候');if(!challenge||challenge.phone!==username)throw Error('请为当前手机号获取验证码');
      await raw('/v1/auth/reset-password',{method:'POST',body:{username,challengeId:challenge.challengeId,verificationCode:inputValue(code),newPassword:inputValue(password),newPasswordConfirmation:inputValue(confirmation)}});if(!alive())return;
      password.input.value='';confirmation.input.value='';code.input.value='';loginPage(false,username);notify('密码已重设，请登录');
    }catch(e){if(alive())showFormError(err,e.message);}finally{if(alive())lockAuthForm(form,submit,false);}
  });
  const card=authCard('重设密码',form),close=authClose(phone,true);card.addEventListener('keydown',event=>{if(event.key==='Escape'&&!submit.disabled){event.preventDefault();close.click();}});authScene.content.append(close,card);card.querySelector('h1').focus({preventScroll:true});
}
async function show(name){web.leavePage();currentPage=name;main.dataset.page=name;const turn=++pageNumber;secondaryNav(name);heading('正在加载','');main.setAttribute('aria-busy','true');const render=pages[name];if(!render)throw Error('页面不存在');try{await render(()=>turn===pageNumber&&!!session);if(turn===pageNumber&&session)main.focus({preventScroll:true});}finally{if(turn===pageNumber)main.removeAttribute('aria-busy');}}
async function paged(path,headers,mapRow,parent=main){let cursor=null,history=[];const container=el('section');parent.append(container);const savedEpoch=epoch,turn=pageNumber;async function load(){const data=await api(path+(path.includes('?')?'&':'?')+'limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(epoch!==savedEpoch||turn!==pageNumber)return;const prev=button('上一页',async()=>{cursor=history.pop()??null;await load();}),next=button('下一页',async()=>{history.push(cursor);cursor=data.nextCursor;await load();});prev.disabled=!history.length;next.disabled=!data.nextCursor;container.replaceChildren(headers?table(headers,data.items.map(mapRow)):el('div',{class:'bank-grid'},data.items.length?data.items.map(mapRow):el('div',{class:'card empty'},icon('library'),el('h2',{},'还没有题库'),el('p',{},'导入文件，开始整理。'))),el('div',{class:'pagination'},prev,el('span',{class:'muted'},`第 ${history.length+1} 页`),next));}await load();}
function questionCard(q,edit){return el('article',{class:'question'},el('div',{class:'row spread'},pill(types[q.questionType]||q.questionType),edit?button('编辑',edit):null),el('p',{class:'stem'},q.stem),q.options?.length?el('div',{class:'pre'},q.options.map(o=>`${o.id}. ${o.text}`).join('\n')):null,el('p',{class:'answer'},q.answerText||'来源未提供答案'),q.explanation?el('p',{class:'muted'},'解析：'+q.explanation):null,pill(q.answerComplete?'答案完整':'答案待完善',q.answerComplete?'good':''),q.errors?.length?el('p',{class:'error-text'},q.errors.join('\n')):null);}
async function preview(importId){return web.preview(importId);}
function editQuestion(importId,q,revision,afterSave){const type=select('题型',types,q.questionType),stem=field('题干','textarea',q.stem),opts=field('选项','textarea',q.options?.map(o=>`${o.id}. ${o.text}`).join('\n'),'选择题每行一个选项，如 A. 北京；非选择题留空。'),answer=field('答案正文','textarea',q.answerText),ids=field('正确选项','text',q.answerOptionIds?.join(','),'单选/多选填写选项编号，以逗号分隔；答案正文须与对应选项内容一致。'),bool=select('判断题答案',{'':'未填写',true:'正确',false:'错误'},typeof q.answerBoolean==='boolean'?String(q.answerBoolean):''),parts=field('填空答案','textarea',q.answerParts?.map(p=>p.text).join('\n'),'按空位顺序每行一个；多空答案正文使用“1. 答案”逐行排列。'),count=field('原题空位数','number',q.expectedBlankCount??''),explanation=field('解析','textarea',q.explanation),source=field('来源','text',q.sourceName),complete=el('input',{type:'checkbox',checked:q.answerComplete});
const box=dialog('纠正题目',[type.node,stem.node,opts.node,answer.node,ids.node,bool.node,parts.node,count.node,explanation.node,source.node,el('label',{class:'check'},complete,'我已核对答案完整；来源未给答案时请勿勾选')],'保存修改',async()=>{const question={questionId:q.questionId,questionType:inputValue(type),stem:inputValue(stem),options:inputValue(opts).trim()?inputValue(opts).split('\n').filter(x=>x.trim()).map(line=>{const m=line.match(/^\s*([^\.．、)）\s]+)[.．、)）]\s*(.+)$/u);if(!m)throw Error('选项格式应为 A. 选项内容');return{id:m[1],text:m[2]};}):[],answerText:inputValue(answer),answerOptionIds:inputValue(ids).split(/[,，\s]+/).filter(Boolean),answerComplete:complete.checked,explanation:inputValue(explanation),sourceName:inputValue(source)};if(question.questionType==='true_false'&&inputValue(bool)!=='')question.answerBoolean=inputValue(bool)==='true';if(question.questionType==='fill_blank'){question.answerParts=inputValue(parts).split('\n').filter(x=>x.trim()).map((text,i)=>({position:i+1,text}));if(inputValue(count)!=='')question.expectedBlankCount=number(count);}if(['single_choice','multiple_choice'].includes(question.questionType)){question.answerOptionIds=question.answerOptionIds.flatMap(id=>/^[A-Z]{2,}$/.test(id)&&[...id].every(x=>question.options.some(o=>o.id===x))?[...id]:[id]);question.answerText=question.answerOptionIds.map(id=>{const option=question.options.find(o=>o.id===id);if(!option)throw Error('正确选项不存在：'+id);return option.text;}).join('\n');delete question.answerBoolean;delete question.answerParts;delete question.expectedBlankCount;}else if(question.questionType==='true_false'){question.options=[];question.answerOptionIds=[];question.answerText=typeof question.answerBoolean==='boolean'?(question.answerBoolean?'正确':'错误'):'';delete question.answerParts;delete question.expectedBlankCount;}else if(question.questionType==='fill_blank'){question.options=[];question.answerOptionIds=[];question.answerText=question.answerParts.length===1?question.answerParts[0].text:question.answerParts.map(p=>p.position+'. '+p.text).join('\n');delete question.answerBoolean;}else{question.options=[];question.answerOptionIds=[];delete question.answerBoolean;delete question.answerParts;delete question.expectedBlankCount;}await api(`/v1/imports/${importId}/questions/${encodeURIComponent(q.questionId)}`,{method:'PATCH',body:{expectedRevision:revision,question}});notify('修改已保存，请再次核对预览');if(afterSave){document.querySelectorAll('dialog').forEach(d=>d.close());await afterSave();}else await show('imports');});
function visibility(){const t=inputValue(type),choice=['single_choice','multiple_choice'].includes(t);opts.node.hidden=ids.node.hidden=!choice;bool.node.hidden=t!=='true_false';parts.node.hidden=count.node.hidden=t!=='fill_blank';answer.node.hidden=!['short_answer','unknown'].includes(t);}
type.input.addEventListener('change',visibility);visibility();
}
async function allBanks(){const items=[];let cursor=null;do{const r=await api('/v1/banks?limit=200'+(cursor?'&cursor='+encodeURIComponent(cursor):''));items.push(...r.items);cursor=r.nextCursor;if(items.length>5000)throw Error('题库列表过大，请使用分组管理后再操作');}while(cursor);return items;}
const bankBrowser=window.TiyuBankBrowser({
  main,api,back:()=>show('banks'),principal:()=>session?.principal,el,button,field,select,icon,notify,types,
  importBank:()=>show('imports'),editBank:(bank,done)=>web.editBank(bank,done),
  begin:()=>{currentPage='banks';const turn=++pageNumber,savedEpoch=epoch;secondaryNav('banks');main.removeAttribute('aria-busy');return()=>turn===pageNumber&&savedEpoch===epoch&&!!session;}
});
async function confirmImport(info){const banks=(await allBanks()).filter(b=>b.visibility==='private'),title=field('题库名称','text',info.title),target=select('保存方式',{'':'新建个人题库',...Object.fromEntries(banks.map(b=>[b.bankId,'替换：'+b.title]))},'');const key=crypto.randomUUID();dialog('确认个人入库',[el('p',{class:'muted'},'个人题库仅你和管理员可见。替换私库不影响已发布版本。'),title.node,target.node],'确认私人入库',async()=>{const body={expectedRevision:info.revision,title:inputValue(title)};if(inputValue(target)){const bank=banks.find(b=>b.bankId===inputValue(target));body.bankId=bank.bankId;body.expectedBankVersion=bank.dataVersion;}await mutation(`/v1/imports/${info.importId}/confirm`,body,'POST',key);notify('已入库，App更新后可查。');await show('banks');});}
async function download(path){const token=session?.accessToken;if(!token)throw Error('请先登录');const saved=epoch;const response=await fetch(path,{headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'omit',redirect:'error'});if(!response.ok)throw Error('原件下载失败；请刷新登录状态后重试');const blob=await response.blob();if(saved!==epoch)throw Error('账号已改变');const url=URL.createObjectURL(blob),a=el('a',{href:url,download:'题库原件'});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const pages={
profile:alive=>web.pages.profile(alive),
banks:alive=>web.pages.banks(alive),
imports:alive=>web.pages.imports(alive),
announcements:async alive=>{const r=await api('/v1/announcements?includeDismissed=true');if(!alive())return;heading('公告','');main.append(...(r.items.length?r.items.map(a=>el('article',{class:'card'},el('h2',{},a.title),el('p',{class:'muted'},date(a.publishedAt)),el('div',{class:'pre'},a.body),button('此版本不再提醒',async()=>{await api(`/v1/announcements/${a.id}/dismiss`,{method:'POST',body:{version:a.version}});notify('已设置当前版本不再提醒');}))):[el('div',{class:'card empty'},'暂无公告')]));},
ledger:async alive=>{await updateMe();if(!alive())return;heading('点数明细',`可用 ${session.account?.pointsAvailable??0} 点。点数用于 AI 调用，本地题库检索不扣点。`);await paged('/v1/me/points-ledger',['时间','变动','变动前','变动后','原因'],i=>[date(i.createdAt),`${i.delta>0?'+':''}${i.delta}`,i.balanceBefore,i.balanceAfter,i.reason]);},
users:async alive=>{if(!alive())return;heading('用户管理','');const search=field('搜索手机号或显示名'),submit=button('搜索',async()=>{container.replaceChildren();await list();});main.append(el('div',{class:'row toolbar'},search.node,submit));const container=el('section');main.append(container);async function list(){await paged('/v1/admin/users'+(inputValue(search)?'?search='+encodeURIComponent(inputValue(search)):''),['用户','注册 / 最近登录','会员 / 试用','点数','状态','操作'],u=>[el('div',{},u.phoneNumber,el('p',{class:'muted'},u.displayName),pill(u.phoneVerified?'手机已验证':'未验证')),el('div',{},date(u.registeredAt),el('p',{class:'muted'},date(u.lastLoginAt))),el('div',{},pill(u.membership==='sponsor'?'赞助版':'Free'),el('p',{class:'muted'},u.membership==='sponsor'?'到期：'+(u.membershipExpiresAt?date(u.membershipExpiresAt):'长期'):'试用至：'+date(u.trialEndsAt))),`${u.pointsAvailable} 可用 / ${u.pointsBalance} 总额`,pill(u.disabled?'已禁用':'正常',u.disabled?'bad':'good'),actions(button('会员',()=>membership(u)),button('点数',()=>adjustPoints(u)),button('流水',()=>userLedger(u)),button(u.disabled?'启用':'禁用',()=>userStatus(u),u.disabled?'':'danger'),button('强制退出',()=>revoke(u)))],container);}await list();},
review:async alive=>{if(!alive())return;heading('题库审核','审核通过后，仍需明确发布。');main.append(el('h2',{},'个人题库'));await paged('/v1/admin/banks',['题库','所有者','题数','操作'],b=>[b.title,b.ownerUserId,b.questionCount,button('审阅具体版本',()=>reviewBank(b))]);main.append(el('h2',{},'上传记录'));await paged('/v1/admin/imports',['原文件','所有者','状态','操作'],i=>[i.filename,i.ownerUserId,states[i.status]||i.status,button('下载原件',()=>download(`/v1/admin/imports/${i.importId}/source`))]);},
releases:async alive=>{if(!alive())return;heading('发布记录','撤回后，用户更新时移除对应题库。');await paged('/v1/admin/releases',['题库','发布版本','状态','操作'],r=>[r.title,r.dataVersion,pill(states[r.state]||r.state,r.state==='published'?'good':''),r.state==='published'?button('撤回',()=>{const reason=el('p',{},`撤回“${r.title}”后不再下发此公共版本。`);dialog('撤回公共发布',[reason],'确认撤回',async operationKey=>{await mutation(`/v1/admin/releases/${r.releaseId}/withdraw`,{},'POST',operationKey);notify('已撤回');await show('releases');});},'danger'):'—']);},
models:async alive=>{if(!alive())return;heading('AI 模型','保存密钥后，测试通过即可启用。');main.append(el('div',{class:'toolbar'},button('添加模型',()=>modelForm(null),'primary')));await paged('/v1/admin/models',['模型','密钥 / 计价','状态','最近测试','操作'],m=>[el('div',{},m.displayName,el('p',{class:'muted'},m.provider+' · '+m.modelId)),`${m.keyConfigured?'已配置密钥':'未配置密钥'} · ${m.pointsPerCall}点/次`,pill(m.enabled?'启用':'停用',m.enabled?'good':''),el('div',{},states[m.lastTestStatus]||m.lastTestStatus,el('p',{class:'muted'},date(m.lastTestAt)),m.lastTestErrorCode||''),modelActions(m)]);},
manageAnnouncements:async alive=>{if(!alive())return;heading('公告管理','');main.append(el('div',{class:'toolbar'},button('新建公告',()=>announcementForm(null),'primary')));await paged('/v1/admin/announcements',['标题','受众','状态','版本 / 时间','操作'],a=>[a.title,{all:'所有用户',free:'Free',sponsor:'赞助版'}[a.audience],states[a.status]||a.status,el('div',{},`第${a.version}版`,el('p',{class:'muted'},date(a.publishedAt))),button('编辑 / 发布',()=>announcementForm(a))]);},
audit:async alive=>{if(!alive())return;heading('操作日志','');await paged('/v1/admin/audit',['时间','操作者','操作','对象','摘要'],i=>[date(i.createdAt),i.actorId||'服务端 CLI',i.action,i.targetId,i.details]);}
};
function membership(u){const type=select('会员类型',{free:'Free',sponsor:'赞助版'},u.membership),expiry=field('赞助到期时间（留空为长期）','datetime-local',u.membershipExpiresAt?localDate(u.membershipExpiresAt):''),reason=field('修改原因');dialog('修改会员：'+u.phoneNumber,[type.node,expiry.node,reason.node],'保存会员',async operationKey=>{await mutation(`/v1/admin/users/${u.userId}/membership`,{membership:inputValue(type),membershipExpiresAt:inputValue(expiry)?new Date(inputValue(expiry)).toISOString():null,expectedRevision:u.revision,reason:inputValue(reason)},'POST',operationKey);notify('会员状态已更新');await show('users');});}
function adjustPoints(u){const delta=field('增减点数','number','','正数增加，负数扣除。'),reason=field('调整原因');dialog('调整点数：'+u.phoneNumber,[el('p',{},`总额${u.pointsBalance}点，可用${u.pointsAvailable}点，预留${u.pointsReserved}点。`),delta.node,reason.node],'确认调整',async operationKey=>{await mutation(`/v1/admin/users/${u.userId}/points-adjustments`,{delta:number(delta),expectedRevision:u.revision,reason:inputValue(reason)},'POST',operationKey);notify('点数已调整并记录流水');await show('users');});}
async function userLedger(u){const r=await api(`/v1/admin/users/${u.userId}/points-ledger?limit=50`);readDialog(u.phoneNumber+' · 最近50条流水',table(['时间','变动','余额','原因'],r.items.map(i=>[date(i.createdAt),i.delta,i.balanceAfter,i.reason])));}
function userStatus(u){const reason=field('操作原因');dialog((u.disabled?'启用':'禁用')+'用户：'+u.phoneNumber,[el('p',{class:'muted'},u.disabled?'启用后用户需要重新登录。':'禁用会立即撤销全部登录会话。离线浮窗最迟在现有许可到期时停用。'),reason.node],'确认'+(u.disabled?'启用':'禁用'),async operationKey=>{await mutation(`/v1/admin/users/${u.userId}/status`,{disabled:!u.disabled,expectedRevision:u.revision,reason:inputValue(reason)},'POST',operationKey);await show('users');});}
function revoke(u){const reason=field('操作原因');dialog('强制退出：'+u.phoneNumber,[reason.node],'撤销全部会话',async operationKey=>{await mutation(`/v1/admin/users/${u.userId}/revoke-sessions`,{reason:inputValue(reason)},'POST',operationKey);notify('该账号全部会话已撤销');});}
async function reviewBank(b){const releaseKey=crypto.randomUUID();const r=await api(`/v1/admin/banks/${b.bankId}/questions?dataVersion=${encodeURIComponent(b.dataVersion)}&limit=50`),comment=field('审核说明','textarea'),content=el('div',{},el('p',{class:'muted'},`当前版本 ${b.dataVersion}，共${r.total}题。`));let offset=0;const qs=el('div');async function fill(data){qs.replaceChildren(...data.items.map(q=>questionCard(q)));const controls=el('div',{class:'pagination'});if(offset>0)controls.append(button('上一组',async()=>{offset-=50;await fill(await api(`/v1/admin/banks/${b.bankId}/questions?dataVersion=${encodeURIComponent(b.dataVersion)}&offset=${offset}&limit=50`));}));if(offset+50<data.total)controls.append(button('下一组',async()=>{offset+=50;await fill(await api(`/v1/admin/banks/${b.bankId}/questions?dataVersion=${encodeURIComponent(b.dataVersion)}&offset=${offset}&limit=50`));}));qs.append(controls);}await fill(r);content.append(qs,comment.node);let reviewId=null;const publish=button('明确发布此版本',async()=>{if(!reviewId)throw Error('请先审核通过当前版本');await mutation(`/v1/admin/banks/${b.bankId}/releases`,{dataVersion:b.dataVersion,reviewId},'POST',releaseKey);notify('已发布公共快照，其他用户更新后可用');await show('releases');box.close();},'primary');publish.disabled=true;const approve=button('审核通过',async()=>{const r=await api(`/v1/admin/banks/${b.bankId}/reviews`,{method:'POST',body:{dataVersion:b.dataVersion,decision:'approved',comment:inputValue(comment)}});reviewId=r.reviewId;publish.disabled=false;approve.disabled=true;notify('审核通过，尚未公开；点击明确发布才会下发。');});const box=el('dialog',{},el('div',{class:'dialogbody'},el('h2',{},b.title),content,el('div',{class:'dialogactions'},button('关闭',()=>box.close()),button('审核不通过',async()=>{await api(`/v1/admin/banks/${b.bankId}/reviews`,{method:'POST',body:{dataVersion:b.dataVersion,decision:'rejected',comment:inputValue(comment)}});notify('已记录不通过');box.close();}),approve,publish)));box.addEventListener('close',()=>box.remove());document.body.append(box);box.showModal();}
async function modelForm(m){
  const catalog=await api('/v1/models/catalog');
  const providers=Object.fromEntries(catalog.byokProviders.map(p=>[p.id,p.name]));
  const provider=select('服务商',providers,m?.provider||'deepseek');
  const binding=select('产品型号',{'':'仅保存配置（不向用户开放）',...Object.fromEntries(catalog.items.map(item=>[item.key,item.name+' · '+item.pointsPerCall+'点/次']))},m?.catalogKey||'');
  const name=field('显示名称','text',m?.displayName),model=field('实际模型 ID / 接入点 ID','text',m?.modelId);
  const key=field(m?'新 API Key（留空保留）':'API Key','password'),price=field('每次调用点数','number',m?.pointsPerCall??1);
  const limit=field('每日调用上限','number',m?.dailyRequestLimit??10),tokens=field('最大输出长度','number',m?.maxOutputTokens??1024),timeout=field('超时（毫秒）','number',m?.timeoutMs??25000),remove=el('input',{type:'checkbox'});
  key.input.autocomplete='off';key.input.spellcheck=false;key.input.dataset.modelSecret='';
  function selection(){const item=catalog.items.find(item=>item.key===inputValue(binding));if(item){provider.input.value=item.provider;price.input.value=item.pointsPerCall;if(!inputValue(name))name.input.value=item.name;}provider.input.disabled=!!item;price.input.readOnly=!!item;}
  binding.input.addEventListener('change',selection);selection();
  const box=dialog(m?'编辑模型':'添加模型',[binding.node,provider.node,name.node,model.node,key.node,m?el('label',{class:'check'},remove,'明确移除已保存的 Key'):null,el('div',{class:'grid'},price.node,limit.node,tokens.node,timeout.node),el('p',{class:'muted'},'选择产品型号后使用固定 1／2 点档位。必须填写供应商实际模型 ID，保存密钥后测试通过并启用，用户才能调用。')],'加密保存',async operationKey=>{
    const p=inputValue(provider),body={provider:p,catalogKey:inputValue(binding)||null,displayName:inputValue(name),modelId:inputValue(model),baseUrl:catalog.byokProviders.find(x=>x.id===p).baseUrl,enabled:false,capabilities:['text'],maxOutputTokens:number(tokens),timeoutMs:number(timeout),dailyRequestLimit:number(limit),pointsPerCall:number(price)};
    if(inputValue(key))body.apiKey=inputValue(key);if(remove.checked)body.removeKey=true;if(m)body.expectedRevision=m.revision;
    try{await mutation('/v1/admin/models'+(m?'/'+m.id:''),body,m?'PATCH':'POST',operationKey);key.input.value='';notify('模型已保存；测试通过并启用后可供用户调用。');await show('models');}
    finally{key.input.value='';delete body.apiKey;}
  });
  box.addEventListener('close',()=>{key.input.value='';});
}
function testModel(m){dialog('发送小额测试调用',[el('p',{},`将向${m.provider}的${m.modelId}发送固定测试文字。供应商可能收取少量费用，不扣普通用户点数。`)],'发送一次测试',async operationKey=>{const r=await mutation(`/v1/admin/models/${m.id}/test`,{expectedRevision:m.revision},'POST',operationKey);notify(r.status==='passed'?`测试通过，用时${r.latencyMs}ms。请确认后在列表启用。`:`测试${r.status==='uncertain'?'结果待核对':'未通过'}：${r.errorCode||'未知原因'}`,r.status!=='passed');await show('models');});}
function modelActions(m){const test=button('测试',()=>testModel(m));test.disabled=!m.keyConfigured;if(test.disabled)test.title='请先配置 API Key';const toggle=button(m.enabled?'停用':'启用',async()=>{await mutation(`/v1/admin/models/${m.id}`,{expectedRevision:m.revision,enabled:!m.enabled},'PATCH');await show('models');});toggle.disabled=!m.enabled&&(!m.keyConfigured||m.lastTestStatus!=='passed');if(toggle.disabled)toggle.title='配置密钥并测试通过后可启用';return actions(button('编辑',()=>modelForm(m)),test,toggle);}
function localDate(iso){const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function announcementForm(a){const title=field('标题','text',a?.title),body=field('公告正文','textarea',a?.body),audience=select('接收用户',{all:'所有用户',free:'Free 用户',sponsor:'赞助版用户'},a?.audience||'all'),status=select('状态',{draft:'保存草稿',published:'发布',withdrawn:'撤回'},a?.status||'draft'),start=field('开始显示时间（可选）','datetime-local',a?.startsAt?localDate(a.startsAt):''),end=field('结束显示时间（可选）','datetime-local',a?.endsAt?localDate(a.endsAt):'');dialog(a?'编辑公告':'新建公告',[title.node,body.node,audience.node,status.node,start.node,end.node],'保存公告',async operationKey=>{const data={title:inputValue(title),body:inputValue(body),audience:inputValue(audience),status:inputValue(status),startsAt:inputValue(start)?new Date(inputValue(start)).toISOString():null,endsAt:inputValue(end)?new Date(inputValue(end)).toISOString():null};if(a)data.expectedVersion=a.version;await mutation('/v1/admin/announcements'+(a?'/'+a.id:''),data,a?'PATCH':'POST',operationKey);await show('manageAnnouncements');notify('公告已保存');});}
const web=window.FloatWorkspace({main,el,button,field,select,icon,notify,api,mutation,show,heading,
  getSession:()=>session,getPageToken:()=>pageNumber,updateMe,mergeSession:next=>{session={...session,...next};accountHeader();},allBanks,bankBrowser,types,dialog,readDialog,paged,download,editQuestion,confirmImport,signOut});
Object.assign(pages,web.pages);
loginPage(false,'',false);
})();
