// KuroBAR GitHub App OAuth admin worker. No credentials are stored in this source.
// Deployment: Cloudflare Workers, keep GITHUB_CLIENT_SECRET as a Worker secret.
const GH = 'https://api.github.com';
const OWNER = 'onihata';
const REPO = 'kurobar-site';
const REPO_ID = '1414101005';
const ALLOWED_LOGIN = 'onihata';
const CONFIG_PATH = 'site-settings.json';
const SCHEDULE_PATH = 'activity-schedule.json';
const MAX_SESSION_AGE = 30 * 24 * 3600;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function textResponse(body, status = 200, type = 'text/plain; charset=utf-8', more = {}) {
  return new Response(body, {status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', ...more
  }});
}
function json(body, status = 200, headers = {}) {
  return textResponse(JSON.stringify(body), status, 'application/json; charset=utf-8', headers);
}
function cookieFrom(req, name) {
  const found = (req.headers.get('Cookie') || '').split(';').map(s => s.trim())
    .find(v => v.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : null;
}
function setCookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function bytes64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
function from64url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error('invalid encoding');
  const bytes = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bytes, c => c.charCodeAt(0));
}
function randomToken(n = 32) { return bytes64url(crypto.getRandomValues(new Uint8Array(n))); }
async function aesKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('kurobar-aes-gcm-v1:' + env.GITHUB_CLIENT_SECRET));
  return crypto.subtle.importKey('raw', digest, {name:'AES-GCM'}, false, ['encrypt','decrypt']);
}
async function seal(value, env) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=encoder.encode(JSON.stringify(value));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await aesKey(env),data));
  return bytes64url(iv)+'.'+bytes64url(encrypted);
}
async function unseal(data, env) {
  if (!data || data.length > 6000) return null;
  try {
    const [a,b]=data.split('.'); if (!a || !b) return null;
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64url(a)},await aesKey(env),from64url(b));
    return JSON.parse(decoder.decode(plain));
  } catch { return null; }
}
function repoUrl(path) {
  return `${GH}/repos/${OWNER}/${REPO}/contents/${path}`;
}
async function github(path, token, init = {}) {
  const response=await fetch(path.startsWith('https://')?path:repoUrl(path), {
    ...init, headers:{
      'Accept':'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10',
      'User-Agent':'KuroBAR-Admin',
      'Authorization':'Bearer '+token,
      ...(init.headers||{})
    }
  });
  if (!response.ok) throw Error(`GitHub API error ${response.status}`);
  return response.json();
}
function decodedFile(file) {
  if (!file?.sha || !file?.content || file.encoding !== 'base64') throw Error('GitHub file format error');
  const raw=atob(file.content.replace(/\s/g,''));
  return JSON.parse(decoder.decode(Uint8Array.from(raw,c=>c.charCodeAt(0))));
}
function encodeFile(data) {
  return btoa(Array.from(encoder.encode(JSON.stringify(data,null,2)+'\n'), b=>String.fromCharCode(b)).join(''));
}
function formatISO(date) {return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date+'T00:00:00Z'));}
function validTime(s) {return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);}
function validateConfig(c) {
  return c && typeof c==='object' && !Array.isArray(c) && typeof c.recruitmentOpen==='boolean' &&
    c.activityOverrides && typeof c.activityOverrides==='object' && !Array.isArray(c.activityOverrides);
}
async function oauthPost(env, body) {
  const response=await fetch('https://github.com/login/oauth/access_token',{
    method:'POST',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,...body})
  });
  if (!response.ok) throw Error('GitHub authorization unavailable');
  const value=await response.json();
  if (value.error || !value.access_token) throw Error('GitHub authorization rejected');
  return value;
}
function sessionFromToken(tok, user) {
  const now=Date.now();
  return {
    version:1, userId:user.id, login:user.login,
    token:tok.access_token, tokenExpires:now+1000*Math.max(600,Number(tok.expires_in)||28800),
    refresh:tok.refresh_token||'',
    refreshExpires:now+1000*Math.max(0,Number(tok.refresh_token_expires_in)||0)
  };
}
async function getSession(req, env) {
  let s=await unseal(cookieFrom(req,'__Host-kb_session'),env);
  if (!s || s.version!==1 || s.login?.toLowerCase()!==ALLOWED_LOGIN || !s.token) return null;
  if (s.tokenExpires < Date.now()+120000) {
    if (!s.refresh || Date.now()>s.refreshExpires-120000) return null;
    try {
      const next=await oauthPost(env,{grant_type:'refresh_token',refresh_token:s.refresh});
      s=sessionFromToken(next,{id:s.userId,login:s.login});
      return {s, updated:true};
    } catch {return null;}
  }
  return {s, updated:false};
}
async function apiResponse(req,env,handler) {
  const context=await getSession(req,env);
  if (!context) return json({error:'ログインが切れました。GitHubで再ログインしてください。',loginRequired:true},401);
  try {
    const result=await handler(context.s.token);
    const response=json(result);
    if(context.updated) response.headers.set('Set-Cookie',setCookie('__Host-kb_session',await seal(context.s,env),MAX_SESSION_AGE));
    return response;
  } catch(e) {
    const err=json({error:String(e.message||e).replace(/[\r\n]/g,' ').slice(0,140)},502);
    if(context.updated) err.headers.set('Set-Cookie',setCookie('__Host-kb_session',await seal(context.s,env),MAX_SESSION_AGE));
    return err;
  }
}
function sameOrigin(req) {
  // POST must originate in the first-party Worker admin UI, not an external website.
  return req.headers.get('Origin')===new URL(req.url).origin &&
    req.headers.get('X-KB-Request')==='1';
}
function redirect(url, cookies=[]) {
  const response=new Response(null,{status:302,headers:{'Location':url,'Cache-Control':'no-store'}});
  cookies.forEach(c=>response.headers.append('Set-Cookie',c));
  return response;
}
async function router(req,env){
  const url=new URL(req.url),path=url.pathname;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return textResponse('認証用のGitHub App設定がまだ完了していません。',503);
  }
  if(req.method==='GET' && path==='/login'){
    const state=randomToken(),verifier=randomToken(48);
    const digest=await crypto.subtle.digest('SHA-256',encoder.encode(verifier));
    const requestCookie=await seal({state,verifier,expires:Date.now()+600000},env);
    const auth=new URL('https://github.com/login/oauth/authorize');
    auth.searchParams.set('client_id',env.GITHUB_CLIENT_ID);
    auth.searchParams.set('redirect_uri',url.origin+'/callback');
    auth.searchParams.set('state',state);
    auth.searchParams.set('code_challenge',bytes64url(new Uint8Array(digest)));
    auth.searchParams.set('code_challenge_method','S256');
    auth.searchParams.set('scope','offline_access');
    auth.searchParams.set('login',ALLOWED_LOGIN);
    auth.searchParams.set('allow_signup','false');
    return redirect(auth.toString(),[setCookie('__Host-kb_oauth',requestCookie,600)]);
  }
  if(req.method==='GET' && path==='/callback'){
    const old=await unseal(cookieFrom(req,'__Host-kb_oauth'),env);
    if (!old || old.expires<Date.now() || url.searchParams.get('state')!==old.state || !url.searchParams.has('code')) {
      return textResponse('本人確認を完了できませんでした。管理画面から再ログインしてください。',400);
    }
    try {
      const tok=await oauthPost(env,{
        code:url.searchParams.get('code'),redirect_uri:url.origin+'/callback',
        code_verifier:old.verifier,repository_id:REPO_ID
      });
      const user=await github(`${GH}/user`,tok.access_token);
      if(user.login?.toLowerCase()!==ALLOWED_LOGIN) return textResponse('このGitHubアカウントには管理権限がありません。',403);
      // Ensure the authorized GitHub App installation can access the intended repo.
      await github(CONFIG_PATH,tok.access_token);
      const s=sessionFromToken(tok,user);
      return redirect(url.origin+'/',[
        setCookie('__Host-kb_oauth','',0),
        setCookie('__Host-kb_session',await seal(s,env),MAX_SESSION_AGE)
      ]);
    }catch(e){return textResponse('GitHubとの接続に失敗しました。アプリがkurobar-siteにインストールされているか確認してください。',502);}
  }
  if(req.method==='POST' && path==='/logout'){
    if(!sameOrigin(req))return json({error:'この操作は許可されていません。'},403);
    const response=json({ok:true});response.headers.set('Set-Cookie',setCookie('__Host-kb_session','',0));
    return response;
  }
  if(req.method==='GET' && path==='/api/initial'){
    return apiResponse(req,env,async token=>{
      const [cfgFile,scheduleFile]=await Promise.all([github(CONFIG_PATH,token),github(SCHEDULE_PATH,token)]);
      const settings=decodedFile(cfgFile),schedule=decodedFile(scheduleFile);
      if(!validateConfig(settings) || !Array.isArray(schedule.activities))throw Error('設定ファイルを確認できません');
      return {settings,activities:schedule.activities};
    });
  }
  if(req.method==='POST' && path==='/api/settings'){
    if(!sameOrigin(req)||!(req.headers.get('Content-Type')||'').startsWith('application/json'))return json({error:'この操作は許可されていません。'},403);
    return apiResponse(req,env,async token=>{
      let input;
      try {input=await req.json();}catch {throw Error('入力データが不正です');}
      if(typeof input.recruitmentOpen!=='boolean' || !formatISO(input.date) || !validTime(input.start)||!validTime(input.end)||input.end<=input.start||
         typeof input.notice!=='string'||input.notice.length>250)throw Error('入力した内容を確認してください');
      const [cfgFile,scheduleFile]=await Promise.all([github(CONFIG_PATH,token),github(SCHEDULE_PATH,token)]);
      const settings=decodedFile(cfgFile),schedule=decodedFile(scheduleFile);
      if(!validateConfig(settings)||!Array.isArray(schedule.activities))throw Error('設定ファイルを確認できません');
      const entry=schedule.activities.find(x=>x.date===input.date);
      if(!entry)throw Error('確定した活動日に登録されていません。日程を確認してください');
      settings.recruitmentOpen=input.recruitmentOpen;
      const plannedTime=String(entry.time||'');
      const desiredTime=input.start+'-'+input.end;
      if(desiredTime===plannedTime && !input.notice.trim()){
        delete settings.activityOverrides[input.date];
      }else{
        settings.activityOverrides[input.date]={time:desiredTime,notice:input.notice.trim()};
      }
      await github(CONFIG_PATH,token,{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:'Update KuroBAR admin settings',content:encodeFile(settings),sha:cfgFile.sha,branch:'main'})
      });
      return {ok:true,settings};
    });
  }
  if(req.method==='GET' && (path==='/' || path==='/index.html')) {
    return textResponse(ADMIN_HTML,200,'text/html; charset=utf-8',{
      'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'"
    });
  }
  if(req.method==='GET' && path==='/health')return json({ok:true,app:'KuroBAR admin GitHub Login'});
  return textResponse('Not found',404);
}
export default {
  async fetch(req,env) {
    try{return await router(req,env);}catch(e){return textResponse('管理画面の処理中にエラーが発生しました。',500);}
  }
};
const ADMIN_HTML = "<!doctype html>\n<html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"referrer\" content=\"no-referrer\"><meta name=\"robots\" content=\"noindex,nofollow,noarchive\">\n<title>苦労BAR｜管理室（GitHubログイン）</title>\n<style>\n:root{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN',sans-serif;color-scheme:light}\n*{box-sizing:border-box}body{margin:0;background:#f6f0e4;color:#392317;padding-bottom:36px}\nheader{background:#4d2716;color:#fff4d9;padding:22px 16px;text-align:center}header h1{font-size:23px;margin:0 0 5px}header p{font-size:13px;margin:0}\nmain{max-width:520px;margin:auto;padding:16px 12px}section{background:white;border:1px solid #dbc6ac;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 2px 3px #41270b13}\nh2{font-size:18px;margin:0 0 12px}.small{font-size:13px;line-height:1.6;color:#70594a}\nlabel{display:block;font-weight:bold;margin:12px 0 6px}input,select,textarea{width:100%;min-height:45px;border:1px solid #b9a696;border-radius:9px;padding:11px;font:inherit;background:white;color:#271a12}\ntextarea{min-height:82px}.row{display:flex;gap:8px}.row>div{flex:1}.row label{font-size:13px}\n.btn{display:block;width:100%;border:0;border-radius:9px;padding:14px;text-decoration:none;text-align:center;font-weight:800;font-size:16px;background:#22733c;color:white;cursor:pointer}\n.btn:disabled{opacity:.55}.secondary{background:#5f503f}.pills{display:flex;gap:8px}.pills button{flex:1;padding:11px 5px;border-radius:9px;border:2px solid #c0a995;background:#eee3d5;color:#3a2b1d;font-size:16px;font-weight:800;cursor:pointer}\n.pills button.active{background:#60371f;border-color:#60371f;color:white}.preview{background:#fff3d4;border:1px solid #d8b67e;border-radius:9px;padding:12px;white-space:pre-wrap;line-height:1.7;overflow-wrap:anywhere}\n#status{white-space:pre-wrap;font-size:14px;line-height:1.6;margin:10px 0}#status.error{color:#ab1d1d}#status.ok{color:#156e37}\n[hidden]{display:none!important}a{color:#165da5}footer{text-align:center;color:#745e4b;font-size:12px;padding:10px}\n</style></head>\n<body>\n<header><h1>🏸 苦労BAR 管理室</h1><p>GitHubでログインして変更・保存</p></header>\n<main>\n<section id=\"loginBox\" hidden><h2>管理者ログイン</h2><p class=\"small\">管理画面の利用には、GitHubの本人確認が必要です。アクセストークンの貼り付けは不要です。</p><a class=\"btn\" href=\"/login\">GitHubでログイン・再認証</a></section>\n<div id=\"editor\" hidden>\n<section><h2>① 新規メンバー募集</h2><div class=\"pills\" role=\"group\" aria-label=\"新規募集\"><button id=\"open\" type=\"button\">募集中 ON</button><button id=\"closed\" type=\"button\">募集停止 OFF</button></div></section>\n<section><h2>② 活動日とお知らせ</h2><label for=\"event\">変更する日付</label><select id=\"event\"></select>\n<div class=\"row\"><div><label for=\"start\">開始時間</label><input id=\"start\" type=\"time\" step=\"900\"></div><div><label for=\"end\">終了時間</label><input id=\"end\" type=\"time\" step=\"900\"></div></div>\n<label for=\"notice\">特別なお知らせ</label><textarea id=\"notice\" maxlength=\"250\" placeholder=\"例：サークル忘年会のため短縮開催\"></textarea>\n<p class=\"small\">体育館の実際の予約時間は変更しません。公開サイトの表示だけ変更します。</p></section>\n<section><h2>③ 公開内容の確認</h2><div id=\"preview\" class=\"preview\"></div></section>\n<section><h2>④ 保存</h2><button id=\"save\" class=\"btn\" type=\"button\">変更を保存</button><p id=\"status\" role=\"status\"></p>\n<button id=\"logout\" type=\"button\" class=\"btn secondary\">ログアウト</button></section>\n</div><section id=\"loading\"><p id=\"loadingText\">GitHubのログイン状態を確認しています…</p></section>\n</main><footer>公開ホームページとは別の管理専用画面です</footer>\n<script>\n(()=>{'use strict';\nconst $=id=>document.getElementById(id);\nlet saved=null,activities=[],selected='',recruitOpen=true,busy=false,dirty=false;\nconst timeOk=x=>/^([01]\\d|2[0-3]):[0-5]\\d$/.test(x);\nconst japaneseDate=d=>{const a=d.split('-');return Number(a[1])+'/'+Number(a[2])+'（'+['日','月','火','水','木','金','土'][new Date(d+'T12:00:00Z').getUTCDay()]+'）'};\nconst today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());\nfunction showLogin(msg){$('loading').hidden=true;$('editor').hidden=true;$('loginBox').hidden=false;if(msg){const p=$('loginBox').querySelector('p');p.textContent=msg;}}\nfunction setStatus(msg,cls=''){$('status').textContent=msg;$('status').className=cls;}\nfunction display(){\n $('open').classList.toggle('active',recruitOpen);$('closed').classList.toggle('active',!recruitOpen);\n $('open').setAttribute('aria-pressed',String(recruitOpen));$('closed').setAttribute('aria-pressed',String(!recruitOpen));\n const a=activities.find(x=>x.date===selected),start=$('start').value,end=$('end').value,notice=$('notice').value.trim();\n $('preview').textContent=`【新規募集】${recruitOpen?'募集中':'一時休止中'}\\n【活動日】${japaneseDate(selected)} ${a?.place||''} ${a?.court||''}\\n【表示時間】${start}〜${end}${notice?'\\n【お知らせ】'+notice:''}`;\n}\nfunction loadDay(date){selected=date;const a=activities.find(x=>x.date===date),override=saved.activityOverrides[date]||{};const time=override.time||a.time||'15:00-18:00';const parts=time.split('-');$('start').value=parts[0];$('end').value=parts[1];$('notice').value=override.notice||'';display();dirty=false;}\nasync function init(){\n try{\n  const r=await fetch('/api/initial',{cache:'no-store'}),data=await r.json();\n  if(r.status===401||data.loginRequired){showLogin(data.error);return;}\n  if(!r.ok)throw Error(data.error||'設定を取得できません');\n  saved=data.settings;recruitOpen=saved.recruitmentOpen;\n  activities=data.activities.filter(x=>x&&typeof x.date==='string'&&x.date>=today()&&typeof x.time==='string'&&typeof x.place==='string').sort((a,b)=>a.date.localeCompare(b.date));\n  if(!activities.length)throw Error('今後の活動日がありません');\n  $('event').replaceChildren();for(const a of activities)$('event').add(new Option(`${japaneseDate(a.date)} ${a.place}`,a.date));\n  const chosen=activities.find(x=>x.date==='2026-12-12')?.date||activities[0].date;$('event').value=chosen;loadDay(chosen);\n  $('loading').hidden=true;$('editor').hidden=false;setStatus('設定を読み込みました。変更後に保存してください。','ok');\n }catch(e){$('loadingText').textContent='読み込みエラー：'+e.message+'。設定やGitHub Appのインストールを確認してください。';$('loginBox').hidden=false;}\n}\n$('open').onclick=()=>{recruitOpen=true;dirty=true;display();};\n$('closed').onclick=()=>{recruitOpen=false;dirty=true;display();};\n$('event').onchange=()=>{if(dirty&&!confirm('未保存の変更は消えます。別の日付に切り替えますか？')){$('event').value=selected;return;}loadDay($('event').value);};\nfor(const key of ['start','end','notice'])$(key).addEventListener('input',()=>{dirty=true;display();});\n$('save').onclick=async()=>{\n if(busy)return;\n const start=$('start').value,end=$('end').value,notice=$('notice').value.trim();\n if(!timeOk(start)||!timeOk(end)||end<=start){setStatus('終了時間は開始時間より後にしてください。','error');return;}\n busy=true;$('save').disabled=true;setStatus('GitHubへ保存しています…');\n try{\n  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-KB-Request':'1'},body:JSON.stringify({recruitmentOpen:recruitOpen,date:selected,start,end,notice})});\n  const data=await r.json();if(r.status===401||data.loginRequired){showLogin('ログインの有効期限が切れました。GitHubで再ログインしてください。');return;}\n  if(!r.ok)throw Error(data.error||'保存できませんでした');\n  saved=data.settings;dirty=false;setStatus('保存できました！ 公開サイトにも順次反映されます。','ok');\n }catch(e){setStatus('保存できませんでした：'+e.message,'error');}\n finally{busy=false;$('save').disabled=false;}\n};\n$('logout').onclick=async()=>{await fetch('/logout',{method:'POST',headers:{'X-KB-Request':'1'}});showLogin('ログアウトしました。再び操作する際はGitHubでログインしてください。');};\ninit();\n})();\n</script></body></html>\n";
