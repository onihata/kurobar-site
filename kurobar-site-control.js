/* 苦労BAR: site-settings.json を公開ホームページに反映する小さな追加スクリプト。
   元の画像・キャラクター・レイアウト・activity-schedule.json は変更しない。 */
(()=>{'use strict';
  const CONFIG_URL='site-settings.json';
  const SCHEDULE_URL='activity-schedule.json';
  const $=(s)=>document.querySelector(s);
  const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
  let settings=null;
  const toToday=()=>new Intl.DateTimeFormat('sv-SE',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(new Date());
  const prettyDate=(iso)=>{const [y,m,d]=iso.split('-').map(Number);return `${m}月${d}日`;};
  const mmdd=(iso)=>{const [y,m,d]=iso.split('-').map(Number);return `${m}/${d}`;};
  const getOverrides=()=>settings?.activityOverrides||{};
  const validOverride=(x)=>x&&typeof x==='object'&&typeof x.time==='string'&&TIME_RE.test(x.time);
  const timeLabel=(time)=>time.replace('-', '〜');
  const css=`
    #kb15-home .kb15-recruit.kb-recruit-closed{position:relative}
    #kb15-home .kb15-recruit.kb-recruit-closed::after{
      content:'現在、新規メンバーの募集を一時休止しています';
      position:absolute;inset:10% 4%;z-index:2;display:flex;align-items:center;justify-content:center;
      padding:9px;background:rgba(52,29,21,.94);border:2px solid #f2d291;border-radius:7px;
      color:#fff3ce;text-align:center;font-weight:900;font-size:clamp(13px,3.5vw,20px);
      line-height:1.4;pointer-events:none
    }
    #kb15-home .kb15-recruit.kb-recruit-closed .kb15-recruit-hit{pointer-events:none}
    #kb15-home #kb-special-notice{
      margin:5px 0 0;padding:5px 7px;border:1px solid #986438;border-radius:5px;
      background:#fff1d1;color:#713b18;text-align:center;font-weight:900;
      font-size:clamp(10px,2.85vw,13px);line-height:1.35;
    }
    #kb15-home #kb-special-notice[hidden]{display:none}
    #screen-join .kb-recruit-closed-message{
      position:relative;z-index:20;margin:10px auto;padding:12px;max-width:90%;
      background:#fff5db;color:#65351f;border:2px solid #a46b35;border-radius:8px;
      text-align:center;font-weight:900;font-size:15px
    }
  `;
  const style=document.createElement('style'); style.textContent=css; document.head.append(style);
  function updateRecruitment(){
    if(!settings)return;
    const open=settings.recruitmentOpen===true;
    const poster=$('#kb15-home .kb15-recruit');
    if(poster){
      poster.classList.toggle('kb-recruit-closed',!open);
      const img=poster.querySelector('img');
      if(img)img.alt=open?'苦労BAR 新規メンバー募集中':'苦労BAR 現在、新規メンバーの募集を一時休止しています';
    }
    const join=$('#screen-join');
    if(join){
      let message=join.querySelector('.kb-recruit-closed-message');
      if(!message){message=document.createElement('p');message.className='kb-recruit-closed-message';
        message.textContent='現在、新規メンバーの募集を一時休止しています。';
        const form=join.querySelector('#join-form');if(form)form.before(message);}
      message.hidden=open;
      const form=join.querySelector('#join-form');
      if(form){form.querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=!open);form.hidden=!open;}
    }
    const seo=$('#kb15-home .kb15-seo p');
    if(seo){const original=seo.dataset.kbOriginalText||seo.textContent;
      seo.dataset.kbOriginalText=original;
      seo.textContent=open?original:original.replace('新規メンバーを募集しています','新規メンバーの募集を一時休止しています');}
  }
  // フォーム送信が既存の処理に到達する前にチェックする。
  document.addEventListener('submit', e=>{
    if(e.target?.id==='join-form'&&settings?.recruitmentOpen===false){
      e.preventDefault();e.stopImmediatePropagation();
      alert('現在、新規メンバーの募集を一時休止しています。');
    }
  },true);
  function updateScheduleRows(){
    const board=$('#schedule-live');if(!board||!settings)return;
    for(const row of board.querySelectorAll('.schedule-row')){
      const dateText=row.querySelector('.date')?.textContent?.trim()||'';
      const timeEl=row.querySelector('.time');if(!timeEl)continue;
      for(const [date,override] of Object.entries(getOverrides())){
        if(!DATE_RE.test(date)||!validOverride(override)||date<toToday())continue;
        if(!dateText.startsWith(mmdd(date)+'('))continue;
        const desired=timeLabel(override.time);
        if(timeEl.textContent!==desired)timeEl.textContent=desired;
        if(override.time!=='15:00-18:00')timeEl.classList.add('is-special-time');
      }
    }
  }
  function updateFormDates(){
    const select=$('#join-date');if(!select||!settings)return;
    for(const opt of select.options){
      const date=opt.value.split('|')[0];const override=getOverrides()[date];
      if(!DATE_RE.test(date)||!validOverride(override))continue;
      const originalTime=opt.value.split('|')[1];if(!TIME_RE.test(originalTime))continue;
      const originalLabel=timeLabel(originalTime),desired=timeLabel(override.time);
      if(opt.textContent.includes(originalLabel)&&originalLabel!==desired){
        opt.textContent=opt.textContent.replace(originalLabel,desired);
      }
    }
  }
  function updateSpecialNotice(schedule){
    const section=$('#kb15-home .kb15-schedule');if(!section||!settings)return;
    let notice=$('#kb-special-notice');
    if(!notice){notice=document.createElement('p');notice.id='kb-special-notice';
      section.append(notice);}
    const activeDates=new Set((schedule?.activities||[])
      .filter(x=>x&&DATE_RE.test(x.date)&&x.date>=toToday()).map(x=>x.date));
    const event=Object.entries(getOverrides()).filter(([date,x])=>
      DATE_RE.test(date)&&date>=toToday()&&activeDates.has(date)&&validOverride(x)&&typeof x.notice==='string'&&x.notice.trim())
      .sort((a,b)=>a[0].localeCompare(b[0]))[0];
    notice.hidden=!event;
    if(event){const [date,x]=event;
      notice.textContent=`🍻 ${prettyDate(date)}：${x.notice.trim()}（${timeLabel(x.time)}）`;
    }else notice.textContent='';
  }
  function patchJoinMessage(){
    const base=window.kbrOpenLineJoin;
    if(typeof base!=='function'||base.kbConfigured)return;
    const wrapped=function(data){
      if(data&&typeof data==='object'&&settings){
        const date=String(data.dateValue||'').split('|')[0];const override=getOverrides()[date];
        if(validOverride(override)){
          const originalTime=String(data.dateValue).split('|')[1]||'';
          const originalLabel=timeLabel(originalTime),desired=timeLabel(override.time);
          let label=String(data.label||'').replace(originalLabel,desired);
          if(override.notice)label+='（'+String(override.notice).slice(0,100)+'）';
          data={...data,label};
        }
      }
      return base.apply(this,[data]);
    };
    wrapped.kbConfigured=true;window.kbrOpenLineJoin=wrapped;
  }
  async function init(){
    try{
      const [configResponse,scheduleResponse]=await Promise.all([
        fetch(CONFIG_URL+'?v='+Date.now(),{cache:'no-store'}),
        fetch(SCHEDULE_URL+'?v='+Date.now(),{cache:'no-store'})
      ]);
      if(!configResponse.ok||!scheduleResponse.ok)throw new Error('設定を読み込めません');
      const config=await configResponse.json();const schedule=await scheduleResponse.json();
      if(typeof config.recruitmentOpen!=='boolean'||!config.activityOverrides||typeof config.activityOverrides!=='object')throw new Error('設定の形式が違います');
      settings=config;
      updateRecruitment();updateScheduleRows();updateFormDates();updateSpecialNotice(schedule);patchJoinMessage();
      const board=$('#schedule-live');
      if(board)new MutationObserver(updateScheduleRows).observe(board,{childList:true,subtree:true});
      const select=$('#join-date');
      if(select)new MutationObserver(updateFormDates).observe(select,{childList:true,subtree:true});
      window.addEventListener('focus',()=>{updateRecruitment();updateScheduleRows();updateFormDates();});
    }catch(err){console.warn('苦労BAR公開設定を読み込めませんでした',err);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
