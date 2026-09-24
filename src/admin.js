// SPDX-License-Identifier: GPL-3.0-or-later
// Public shell contains no identity/configuration; every data/action request is authorized by the server.
export const adminPage='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MieMie 治理后台</title><h1>MieMie 治理后台</h1><p>作者内容只能由投稿者编辑。此后台仅用于治理。</p><p id="status" role="status"></p><main id="app"></main><script src="/admin.js" defer></script></html>';
function consoleApp() {
  'use strict';
  let token=null,identity=null,loggingIn=false,popup=null;
  const root=document.getElementById('app'),status=document.getElementById('status');
  const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const notify=text=>{status.textContent=text;};
  async function api(path,body) {
    const r=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'omit',cache:'no-store',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const data=await r.json();if(!r.ok){if(r.status===401){token=null;identity=null;home();}throw Error(data.error?.message||'请求失败');}return {data,status:r.status};
  }
  function button(parent,label,fn){const b=el('button',label);b.type='button';b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{notify('');await fn();}catch(e){notify(e.message);}finally{b.disabled=false;}};parent.append(b);return b;}
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
    root.replaceChildren();
    if(!token){button(root,'使用 Discord 登录',login);return;}
    await refreshIdentity();root.append(el('p',identity.profile.displayName));
    button(root,'退出登录',async()=>{await api('/api/auth/logout',{});token=null;identity=null;await home();});
    if(!identity.isAdmin||identity.canSubmit===false){root.append(el('p','当前账号没有治理权限。'));return;}
    button(root,'投稿管理',()=>submissions(1));
    if(identity.isOwner){button(root,'角色与封禁',()=>users(1));button(root,'治理审计',()=>audit(1));}
    const section=el('section');section.id='view';root.append(section);await submissions(1);
  }
  function view(){const v=document.getElementById('view');v.replaceChildren();return v;}
  function paging(v,page,total,load){if(page>1)button(v,'上一页',()=>load(page-1));if(page*50<total)button(v,'下一页',()=>load(page+1));}
  const reasonInput=parent=>{const label=el('label','操作原因（必填）'),input=el('input');input.maxLength=500;label.append(input);parent.append(label);return input;};
  async function submissions(page){
    const {data}=await api('/api/admin/submissions?page='+page),v=view();
    for(const row of data.items){const card=el('article');card.append(el('h2',row.name),el('p',`${row.classification} · ${row.status} · ${row.moderation} · 作者：${row.author}`),el('p',row.description));
      const reason=reasonInput(card),base='/api/admin/submissions/'+encodeURIComponent(row.id);
      for(const [action,label] of [['hide','Hide'],['restore','Recover']])button(card,label,async()=>{await api(base+'/moderation',{action,reason:reason.value});await submissions(page);});
      if(identity.isOwner){for(const [path,value,label] of [['protection',row.moderationProtected,'保护'],['security-hold',row.securityHold,'Security Hold']])button(card,(value?'解除':'设置')+label,async()=>{await api(base+'/'+path,{enabled:!value,reason:reason.value});await submissions(page);});}
      v.append(card);
    }paging(v,page,data.total,submissions);
  }
  async function users(page){
    const {data}=await api('/api/admin/identities?page='+page),v=view();
    for(const user of data.items){const card=el('article');card.append(el('h2',user.display_name),el('p',user.discord_id+' · '+user.roles.join(', ')));const reason=reasonInput(card),base='/api/admin/identities/'+user.discord_id;
      button(card,user.banned?'Unban':'Ban',async()=>{await api(base+'/ban',{banned:!user.banned,reason:reason.value});await users(page);});
      for(const role of ['admin','official_publisher']){const enabled=user.roles.includes(role);button(card,(enabled?'撤销 ':'授予 ')+role,async()=>{await api(base+'/roles',{role,enabled:!enabled,reason:reason.value});await users(page);});}v.append(card);
    }paging(v,page,data.total,users);
  }
  async function audit(page){const {data}=await api('/api/admin/audit?page='+page),v=view();for(const row of data.items)v.append(el('pre',JSON.stringify(row,null,2)));paging(v,page,data.total,audit);}
  window.addEventListener('pagehide',()=>{token=null;identity=null;});void home();
}
export const adminScript='('+consoleApp.toString()+')();';
