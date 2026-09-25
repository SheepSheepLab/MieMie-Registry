// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync} from 'node:fs';
// Public assets contain no account/configuration data; all requests remain server-authorized.
export const adminStyle=readFileSync(new URL('./admin.css',import.meta.url),'utf8');
export const adminPage=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MieMie · Registry 治理</title><link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body><header class="topbar"><a class="brand" href="/admin"><span class="brand-mark" aria-hidden="true">M</span><span>MieMie <small>REGISTRY / GOVERNANCE</small></span></a><span class="topbar-note">目录治理控制台</span></header>
<p id="status" role="status" aria-live="polite"></p><main id="app"></main><footer class="page-footer">MieMie Registry · 作者内容由投稿者维护，平台身份由 Owner 治理。</footer></body></html>`;
function consoleApp() {
  'use strict';
  let token=null,identity=null,loggingIn=false,popup=null,sessionEpoch=0,viewEpoch=0,closeDialog=null;
  const root=document.getElementById('app'),status=document.getElementById('status');
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const notify=text=>{status.textContent=text;};
  const accountLabel=user=>user.banned?'受限用户':user.isAdmin?'管理员':'普通用户';
  const badge=(text,tone='muted')=>el('span',text,'badge '+tone);
  async function api(path,body) {
    const epoch=sessionEpoch;
    const r=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'omit',cache:'no-store',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const data=await r.json();
    if(epoch!==sessionEpoch)throw Error('登录状态已改变，请重新操作');
    if(!r.ok){if(r.status===401){token=null;identity=null;++sessionEpoch;void home();}throw Error(data.error?.message||'请求失败');}
    return {data,status:r.status};
  }
  function button(parent,label,fn,cls='') {
    const b=el('button',label,cls);b.type='button';
    b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{notify('');await fn();}catch(e){notify(e.message);}finally{b.disabled=false;}};
    parent.append(b);return b;
  }
  async function login() {
    if(loggingIn)return;loggingIn=true;popup=window.open('about:blank','miemie-admin-login','width=560,height=760');
    try {
      if(!popup)throw Error('请允许 Discord 登录弹窗');
      const verifier=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
      const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
      const {data:start}=await api('/api/auth/start',{returnOrigin:location.origin,codeChallenge:challenge});popup.location=start.authorizationUrl;
      const deadline=Date.now()+300000;
      while(Date.now()<deadline){await new Promise(r=>setTimeout(r,2000));const r=await api('/api/auth/complete',{requestId:start.requestId,codeVerifier:verifier});if(r.status===202)continue;token=r.data.token;identity=r.data;try{popup.close();}catch{}await home();return;}
      throw Error('登录超时，请重试');
    } finally {loggingIn=false;}
  }
  async function refreshIdentity(){const {data}=await api('/api/me');identity=data;return data;}
  async function home(){
    ++viewEpoch;closeDialog?.();root.replaceChildren();root.className='';
    if(!token){const welcome=el('section',undefined,'welcome');welcome.append(el('p','REGISTRY GOVERNANCE','eyebrow'),el('h1','让每一次治理清晰可追溯'),el('p','管理扩展目录、核对项目身份，记录每一次平台决策。','lead'));button(welcome,'使用 Discord 登录',login,'primary');welcome.append(el('p','使用已有 Discord 账号登录。仅管理员可访问治理数据。','muted'));root.append(welcome);return;}
    await refreshIdentity();root.replaceChildren();root.className='console';
    const sidebar=el('aside',undefined,'sidebar'),account=el('div',undefined,'account');account.append(el('span','当前账号','eyebrow'),el('strong',identity.profile.displayName),badge(accountLabel(identity),identity.banned?'warning':'accent'));
    button(account,'退出登录',async()=>{await api('/api/auth/logout',{});token=null;identity=null;++sessionEpoch;await home();},'quiet');
    const nav=el('nav');nav.setAttribute('aria-label','治理导航');sidebar.append(el('p','工作区','eyebrow'),nav,account);root.append(sidebar);
    const section=el('section',undefined,'workspace');section.id='view';root.append(section);
    if(!identity.isAdmin||identity.banned===true||identity.canSubmit===false){section.append(el('h1','当前账号没有治理权限。'),el('p',identity.banned?'受限状态仅限制 Registry 投稿和治理能力，不影响使用开源 Hub。':'请使用拥有管理权限的账号登录。','muted'));return;}
    button(nav,'投稿管理',()=>submissions(1));
    if(identity.isOwner){button(nav,'角色与封禁',()=>users(1));button(nav,'治理审计',()=>audit(1));}
    await submissions(1);
  }
  // A later page or session always wins over an earlier asynchronous list response.
  async function load(path,title,subtitle,page,reload){
    const serial=++viewEpoch,section=document.getElementById('view');closeDialog?.();
    const {data}=await api(path+'?page='+page);
    if(serial!==viewEpoch||!section?.isConnected)return null;
    section.replaceChildren();
    for(const b of root.querySelectorAll('nav button')){if(b.textContent===title)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
    const header=el('div',undefined,'view-header'),heading=el('div');heading.append(el('p','治理工作区 / '+title,'eyebrow'),el('h1',title),el('p',subtitle,'muted'));header.append(heading);button(header,'刷新列表',()=>reload(page),'quiet');section.append(header);
    const summary=el('div',undefined,'summary');summary.append(el('span','可见记录 '+data.total),el('span','第 '+page+' 页'),el('span','本页 '+data.items.length+' 条'));section.append(summary);
    return {data,v:section};
  }
  function table(v,labels){
    const wrap=el('div',undefined,'table-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','治理数据，可横向滚动');
    const table=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');
    for(const label of labels){const th=el('th',label);th.scope='col';tr.append(th);}head.append(tr);table.append(head,body);wrap.append(table);v.append(wrap);return body;
  }
  const cell=(row,cls)=>{const td=el('td',undefined,cls);row.append(td);return td;};
  const detail=(parent,label,value)=>{const line=el('div',undefined,'detail');line.append(el('span',label,'field-label'),el('span',value||'未提供'));parent.append(line);};
  function empty(v){v.append(el('p','暂无可显示的记录。','empty'));}
  function paging(v,page,total,load){const p=el('div',undefined,'paging');if(page>1)button(p,'上一页',()=>load(page-1));p.append(el('span','第 '+page+' 页 / 共 '+Math.max(1,Math.ceil(total/50))+' 页','muted'));if(page*50<total)button(p,'下一页',()=>load(page+1));v.append(p);}
  // Every governance POST is reachable only after this explicit confirmation.
  function confirmAction({label,name,details,path,body,reload,returnFocus}){
    if(closeDialog)return Promise.resolve();
    return new Promise(resolve=>{
      const dialog=el('dialog',undefined,'confirm-dialog'),form=el('form'),title=el('h2','确认'+label+'？');title.id='confirm-title';
      dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby','confirm-description');
      const description=el('p','你正在对「'+name+'」执行：'+label+'。');description.id='confirm-description';
      const target=el('div',undefined,'confirm-target');for(const [key,value]of details)detail(target,key,value);
      const reasonLabel=el('label','操作原因（必填）'),reason=el('textarea');reason.name='reason';reason.required=true;reason.maxLength=500;reason.rows=3;reason.placeholder='说明此次操作的依据，将写入治理审计';reasonLabel.append(reason);
      const error=el('p',undefined,'dialog-error');error.setAttribute('role','alert');
      const actions=el('div',undefined,'dialog-actions'),cancel=el('button','取消'),confirm=el('button','确认执行','primary');cancel.type='button';confirm.type='submit';actions.append(cancel,confirm);
      form.append(el('p','确认治理操作','eyebrow'),title,description,target,reasonLabel,error,actions);dialog.append(form);document.body.append(dialog);
      const focused=returnFocus||document.activeElement,epoch=sessionEpoch;let busy=false,done=false;
      const finish=()=>{if(done)return;done=true;closeDialog=null;dialog.close();dialog.remove();resolve();queueMicrotask(()=>{if(focused?.isConnected)focused.focus();});};
      closeDialog=finish;cancel.onclick=()=>{if(!busy)finish();};dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)finish();});
      form.onsubmit=async event=>{
        event.preventDefault();if(busy||done)return;
        if(!reason.value.trim()){error.textContent='请填写操作原因。';reason.focus();return;}
        if(!form.reportValidity())return;
        busy=true;cancel.disabled=confirm.disabled=reason.disabled=true;error.textContent='';confirm.textContent='正在提交…';
        try {
          if(epoch!==sessionEpoch)throw Error('登录状态已改变，请重新操作');
          await api(path,{...body,reason:reason.value.trim()});finish();notify('已完成：'+label+' · '+name);
          try{await reload();}catch(e){notify('操作已完成，列表刷新失败：'+e.message);}
        }catch(e){if(!done){error.textContent=e.message;busy=false;cancel.disabled=confirm.disabled=reason.disabled=false;confirm.textContent='确认执行';}}
      };
      dialog.showModal();reason.focus();
    });
  }
  function operation(parent,label,target,path,body,reload){const trigger=button(parent,label,()=>confirmAction({label,...target,path,body,reload,returnFocus:trigger}));}
  async function submissions(page){
    const result=await load('/api/admin/submissions','投稿管理','核对具体项目后执行治理。扩展身份、投稿者与作者相互独立。',page,submissions);if(!result)return;const {data,v}=result;
    if(!data.items.length)empty(v);else{
      const tbody=table(v,['项目 / 身份','来源 / 项目标识','作者 / 投稿者','治理状态','操作']);
      for(const row of data.items){
        const tr=el('tr');tr.dataset.submissionId=row.id;tbody.append(tr);
        const project=cell(tr,'project-cell');project.append(el('h2',row.name),badge(row.classification==='official'?'🐑官方扩展':'🧩社区扩展',row.classification==='official'?'accent':'muted'),el('p',row.description,'description'));
        const source=cell(tr,'source-cell');detail(source,'Source / Repository',row.sourceUrl);detail(source,'Extension ID',row.extensionId);detail(source,'Submission ID',row.id);if(row.websiteUrl)detail(source,'Website',row.websiteUrl);
        const people=cell(tr);detail(people,'Author',row.author);detail(people,'Submitter',row.submitter.displayName);if(row.submitterDiscordUserId)detail(people,'Discord ID',row.submitterDiscordUserId);
        const state=cell(tr,'state-cell');state.append(badge(row.status==='listed'?'已上架':'已下架',row.status==='listed'?'success':'muted'),badge(({visible:'可见',hidden:'已隐藏',unlisted:'治理下架'})[row.moderation]||row.moderation,row.moderation==='visible'?'success':'warning'),badge(row.moderationProtected?'Protection · 已保护':'Protection · 未保护',row.moderationProtected?'accent':'muted'));
        if(typeof row.securityHold==='boolean')state.append(badge(row.securityHold?'Security Hold · 已启用':'Security Hold · 未启用',row.securityHold?'warning':'muted'));
        const actions=el('div',undefined,'row-actions');cell(tr,'actions-cell').append(actions);
        const base='/api/admin/submissions/'+encodeURIComponent(row.id),target={name:row.name,details:[['Source / Repository',row.sourceUrl],['Submission ID',row.id],['Extension ID',row.extensionId],['Submitter',row.submitter.displayName+(row.submitterDiscordUserId?' · '+row.submitterDiscordUserId:'')]]},reload=()=>submissions(page);
        for(const [action,label]of [['hide','Hide'],['restore','Recover']])operation(actions,label,target,base+'/moderation',{action},reload);
        if(identity.isOwner){
          operation(actions,row.classification==='official'?'改为🧩社区扩展':'设为🐑官方扩展',target,base+'/classification',{classification:row.classification==='official'?'community':'official',projectIdentityKey:row.projectIdentityKey},reload);
          for(const [path,value,label]of [['protection',row.moderationProtected,'保护'],['security-hold',row.securityHold,'Security Hold']])operation(actions,(value?'解除':'设置')+label,target,base+'/'+path,{enabled:!value},reload);
        }
      }
    }paging(v,page,data.total,submissions);
  }
  async function users(page){
    const result=await load('/api/admin/identities','角色与封禁','受限状态只限制 Registry 投稿和治理，不影响使用开源 Hub。',page,users);if(!result)return;const {data,v}=result;
    if(!data.items.length)empty(v);else{
      const tbody=table(v,['账号','当前身份 / 受限状态','当前角色','操作']);
      for(const user of data.items){
        const tr=el('tr');tr.dataset.identityId=user.discord_id;tbody.append(tr);
        const profile=cell(tr);profile.append(el('h2',user.display_name));detail(profile,'Discord ID',user.discord_id);
        const state=cell(tr);state.append(badge(accountLabel(user),user.banned?'warning':'accent'));detail(state,'受限状态',user.banned?'受限':'正常');
        cell(tr).append(el('p',user.isOwner?'Owner · 根身份':user.roles.length?user.roles.map(role=>role==='admin'?'管理员 (admin)':'历史 Publisher').join(' / '):'无附加角色'));
        const actions=el('div',undefined,'row-actions');cell(tr,'actions-cell').append(actions);
        if(user.isOwner){actions.append(el('span','根身份受保护','muted'));continue;}
        const base='/api/admin/identities/'+user.discord_id,target={name:user.display_name,details:[['Discord ID',user.discord_id],['当前身份',accountLabel(user)]]},reload=()=>users(page);
        operation(actions,user.banned?'Unban · 解除限制':'Ban · 限制账号',target,base+'/ban',{banned:!user.banned},reload);
        for(const role of ['admin','official_publisher']){const enabled=user.roles.includes(role);if(role==='official_publisher'&&!enabled)continue;operation(actions,(enabled?'撤销':'授予')+(role==='admin'?'管理员':'历史 Publisher'),target,base+'/roles',{role,enabled:!enabled},reload);}
      }
    }paging(v,page,data.total,users);
  }
  async function audit(page){
    const result=await load('/api/admin/audit','治理审计','由服务器记录操作人、目标、原因和变更前后状态。',page,audit);if(!result)return;const {data,v}=result;
    if(!data.items.length)empty(v);else{
      const tbody=table(v,['时间 / 操作','操作人 / 目标','原因','变更详情']);
      for(const row of data.items){const tr=el('tr');tbody.append(tr);const action=cell(tr);action.append(badge(row.action,'accent'),el('p',new Date(row.created_at).toLocaleString('zh-CN')));const target=cell(tr);detail(target,'操作人',row.actor_id);detail(target,'目标',row.target_id);cell(tr).append(el('p',row.reason||'—'));const details=el('details');details.append(el('summary','查看记录'),el('pre',JSON.stringify(row,null,2)));cell(tr).append(details);}
    }paging(v,page,data.total,audit);
  }
  window.addEventListener('pagehide',()=>{token=null;identity=null;++sessionEpoch;++viewEpoch;closeDialog?.();});void home();
}
export const adminScript='('+consoleApp.toString()+')();';
