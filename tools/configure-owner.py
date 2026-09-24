#!/usr/bin/env python3
"""Root-only interactive bootstrap. Never accepts Discord IDs in command arguments or prints them."""
import os, sys, sqlite3, pathlib, tempfile, stat

def main():
    if os.geteuid() != 0 or not sys.stdin.isatty():
        raise RuntimeError('请由 root 在私有 Workbench 交互终端运行')
    env=pathlib.Path('/etc/miemie-registry/registry.env')
    info=env.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('私有配置权限不安全，停止')
    content=env.read_text()
    if any(line.startswith('MIEMIE_OWNER_DISCORD_ID=') and line.split('=',1)[1].strip() for line in content.splitlines()):
        raise RuntimeError('Owner 已配置；此工具不覆盖根身份')
    with sqlite3.connect('file:/var/lib/miemie-registry/registry.sqlite?mode=ro',uri=True) as db:
        users=db.execute('SELECT discord_id,display_name,username,banned FROM identities ORDER BY profile_updated_at DESC').fetchall()
    if not users: raise RuntimeError('请先使用 Discord 登录，再运行此工具')
    def safe(value): return ''.join(c for c in value if c.isprintable())[:100]
    print('仅在本机私有终端核对 Discord 显示名 / 用户名；不会打印 User ID。')
    for i,(_,name,username,banned) in enumerate(users,1):
        print(f'{i}. {safe(name)} / {safe(username)}' + (' [已封禁，不可选]' if banned else ''))
    selected=int(input('选择你本人的账号序号：'))-1
    if selected<0 or selected>=len(users) or users[selected][3]: raise RuntimeError('选择无效')
    if input('确认这就是 SheepSheep 本人账号并授予平台根权限？输入 OWNER：') != 'OWNER':
        raise RuntimeError('已取消，没有修改')
    value=users[selected][0]
    if not value.isdigit() or not 15<=len(value)<=22:raise RuntimeError('身份格式无效')
    lines=[line for line in content.splitlines() if not line.startswith('MIEMIE_OWNER_DISCORD_ID=')]
    lines.append('MIEMIE_OWNER_DISCORD_ID='+value)
    fd,name=tempfile.mkstemp(prefix='.owner-',dir=env.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:f.write('\n'.join(lines)+'\n');f.flush();os.fsync(f.fileno())
        os.replace(name,env)
        dirfd=os.open(env.parent,os.O_DIRECTORY)
        try:os.fsync(dirfd)
        finally:os.close(dirfd)
    finally:
        if os.path.exists(name):os.unlink(name)
    print('Owner 私有配置已保存。请让部署流程重启 Registry 并验证；无需分享账号 ID。')
if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt):
        print('未完成 Owner 初始化。请确认私有配置权限与所选账号；不会回显内部身份。',file=sys.stderr)
        sys.exit(1)
