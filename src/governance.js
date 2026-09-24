// SPDX-License-Identifier: GPL-3.0-or-later
import {fail,text} from './validation.js';
export const moderationSnapshot = row => ({classification:row.classification,moderation:row.moderation,protected:!!row.moderation_protected,securityHold:!!row.security_hold});
export function rolesFor(config,store,user) {
  const owner=!!config.ownerId&&user.discord_id===config.ownerId;
  const roles=store.rolesFor(user.discord_id);
  return {isOwner:owner,isAdmin:owner||roles.includes('admin'),canPublishOfficial:owner||roles.includes('official_publisher')};
}
export function validateProduct(input,github,auth,previous=null) {
  if(input.classification==='official'&&!auth.canPublishOfficial)fail(403,'official_forbidden','需要 Official Publisher 或 Owner 权限');
  if(input.distribution==='managed_install'&&(input.type!=='tavern_extension'||input.sourceType!=='github'||github?.compatibility!=='installable'))fail(400,'package_required','托管安装需要有效 Tavern Extension Package');
}
export function handleGovernance({path,method,body,auth,store,config,now,query}) {
  if(!auth.isAdmin)fail(403,'forbidden','需要管理员权限');
  if(auth.user.banned)fail(403,'banned','该账号当前禁止管理项目');
  const owner=()=>{if(!auth.isOwner)fail(403,'owner_required','仅 Owner 可执行');};
  const page=Number(query.get('page')||1);
  if(!Number.isInteger(page)||page<1||page>10000)fail(400,'invalid_query','页码无效');
  const actor=auth.user.discord_id;
  if(path==='/api/admin/submissions'&&method==='GET') {
    const {rows,total}=store.listAdmin(page,auth.isOwner);
    return {items:rows.map(row=>({...store.entryDTO(row,true),...(auth.isOwner?{ownerDiscordUserId:row.owner_id,submitterDiscordUserId:row.submitter_id,securityHold:!!row.security_hold,submitterBanned:!!store.getIdentity(row.owner_id).banned}:{})})),page,pageSize:50,total,hasMore:page*50<total};
  }
  if(path==='/api/admin/audit'&&method==='GET'){owner();return {...store.listAudit(page),page};}
  if(path==='/api/admin/identities'&&method==='GET'){owner();return {...store.listIdentities(page),page};}
  const item=/^\/api\/admin\/submissions\/([^/]+)\/(moderation|protection|security-hold)$/.exec(path);
  if(item&&method==='POST') {
    const row=store.getEntry(item[1]);if(!row)fail(404,'not_found','项目不存在');
    const reason=text(body.reason,'原因',500);
    const before=moderationSnapshot(row);let action;
    if(item[2]==='moderation') {
      if(!auth.isOwner&&(row.classification!=='community'||row.moderation_protected))fail(403,'protected_item','管理员只能管理未保护的 Community 项目');
      const states={hide:'hidden',restore:'visible'};
      if(!Object.hasOwn(states,body.action))fail(400,'invalid_action','仅支持 Hide / Recover');
      action=body.action;
      store.transaction(()=>{store.setModeration(row.id,states[action],reason,now());store.audit(actor,action,row.id,reason,now(),before,moderationSnapshot(store.getEntry(row.id)));});
    } else {
      owner();if(typeof body.enabled!=='boolean')fail(400,'invalid_input','enabled 必须为布尔值');
      action=item[2];store.transaction(()=>{(action==='protection'?store.setProtection:store.setHold)(row.id,body.enabled);store.audit(actor,action,row.id,reason,now(),before,moderationSnapshot(store.getEntry(row.id)));});
    }
    return {ok:true};
  }
  const identity=/^\/api\/admin\/identities\/(\d{15,22})\/(ban|roles)$/.exec(path);
  if(identity&&method==='POST') {
    owner();const id=identity[1];if(id===config.ownerId)fail(403,'owner_immutable','Owner 根身份不能从后台修改');
    const user=store.getIdentity(id);if(!user)fail(404,'not_found','用户必须先使用 Discord 登录');
    const reason=text(body.reason,'原因',500);
    if(identity[2]==='ban') {
      if(typeof body.banned!=='boolean')fail(400,'invalid_input','banned 必须为布尔值');
      store.transaction(()=>{store.setBanned(id,body.banned);store.audit(actor,body.banned?'ban':'unban',id,reason,now(),{banned:!!user.banned},{banned:body.banned});});
    } else {
      if(!['admin','official_publisher'].includes(body.role)||typeof body.enabled!=='boolean')fail(400,'invalid_role','角色无效');
      const before={roles:store.rolesFor(id)};
      store.transaction(()=>{store.setRole(id,body.role,body.enabled);store.audit(actor,(body.enabled?'grant_':'revoke_')+body.role,id,reason,now(),before,{roles:store.rolesFor(id)});});
    }
    return {ok:true};
  }
  fail(404,'not_found','管理接口不存在；不能编辑作者内容');
}
