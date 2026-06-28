// ===================================================================
// 骨格診断 MVP — メインコントローラ
// 問診(必須)＋全身写真(任意・MediaPipe Poseで肩/ヒップ比) → 3タイプ → 結果
// ===================================================================
import { QUESTIONS, TYPES, TYPE_ORDER, MIX_HINT, MIX_COMBO, QUESTION_HINTS } from './data.js?v=7';
import { extractPose } from './analyzer.js?v=3';
import { diagnose } from './diagnosis.js?v=4';

const $=s=>document.querySelector(s);
const POSE_MODEL='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const VISION='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';
const BOOKING_URL='#'; // ← 予約/LINE等のURLに差し替え（# のままは非表示）
const COLORIA_URL='https://yuya-suzuki-37.github.io/coloria-atelier/'; // パーソナルカラー診断（掛け合わせ導線）

const state={ canvas:null, ctx:null, W:0, H:0, imageData:null, loaded:false, pose:null, objURL:null };
let poseLandmarker=null;

function setStatus(t){ const el=$('#pc-status'); if(el) el.textContent=t; }
window.addEventListener('error', e=>{ setStatus('⚠️ エラー: '+(e.message||e.error)); });
window.addEventListener('unhandledrejection', e=>{ setStatus('⚠️ エラー: '+((e.reason&&e.reason.message)||e.reason)); });
function showLoading(t){ $('#pc-loading-text').textContent=t||'処理中…'; $('#pc-loading').hidden=false; }
function hideLoading(){ $('#pc-loading').hidden=true; }

function revealTool(){ const s=$('#start'); s.hidden=false; s.scrollIntoView({behavior:'smooth',block:'start'}); }
document.querySelectorAll('.js-reveal').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();revealTool();}));

// ---- HEIC(iPhone写真) 遅延ロード ----
let _heicMod=null;
function getHeic(){ if(!_heicMod) _heicMod=import('https://cdn.jsdelivr.net/npm/heic-to/+esm'); return _heicMod; }

// ---- blob を canvas に描画 ----
function loadImageBlob(blob){
  if(state.objURL) URL.revokeObjectURL(state.objURL);
  state.objURL=URL.createObjectURL(blob);
  const img=new Image();
  img.onload=()=>{
    const maxW=460, sc=Math.min(1, maxW/img.width);
    const W=Math.round(img.width*sc), H=Math.round(img.height*sc);
    const cv=$('#pc-canvas'); cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(img,0,0,W,H);
    state.canvas=cv; state.ctx=ctx; state.W=W; state.H=H;
    state.imageData=ctx.getImageData(0,0,W,H).data;
    state.loaded=true; state.pose=null;
    URL.revokeObjectURL(state.objURL); state.objURL=null;
    $('#pc-preview').hidden=false;
    markPhotoQuestionsPending();
    setStatus('全身写真を読み込みました。下の質問に答えて「診断する」を押すと、写真も解析して総合診断します。');
  };
  img.onerror=()=>{ hideLoading(); setStatus('⚠️ この画像形式は表示できませんでした。JPEGまたはPNGでお試しください。'); };
  img.src=state.objURL;
}

async function handleFile(f){
  if(!f){ setStatus('画像が取得できませんでした。'); return; }
  setStatus(`画像を処理中… (${f.name||'貼り付け画像'} / ${(f.size/1024/1024).toFixed(1)}MB)`);
  const strongHeic = /image\/(heic|heif)/i.test(f.type) || /\.(heic|heif)$/i.test(f.name||'');
  const heicLike = strongHeic || (f.type==='' && f.size>0);
  if(heicLike){
    try{
      showLoading('iPhoneの写真(HEIC)をJPEGに変換しています…');
      const mod=await getHeic();
      const jpg=await mod.heicTo({ blob:f, type:'image/jpeg', quality:0.9 });
      hideLoading(); loadImageBlob(jpg); return;
    }catch(err){
      hideLoading(); console.error(err);
      if(strongHeic){ setStatus('⚠️ HEICの変換に失敗しました。iPhoneの設定→カメラ→フォーマット→「互換性優先」にするかJPEGで書き出してお試しください（写真なしでも診断できます）。'); return; }
      loadImageBlob(f); return;
    }
  }
  loadImageBlob(f);
}

$('#pc-file').addEventListener('change', e=>{ const f=e.target.files[0]; if(f) handleFile(f); });
document.addEventListener('paste', e=>{
  const dt=e.clipboardData; if(!dt) return;
  if(dt.files && dt.files.length){ e.preventDefault(); revealTool(); handleFile(dt.files[0]); return; }
  for(const it of (dt.items||[])){ if(it.kind==='file'){ const f=it.getAsFile(); if(f){ e.preventDefault(); revealTool(); handleFile(f); return; } } }
});
(function(){
  const dz=$('#pc-upload'); if(!dz) return;
  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev,e=>{ e.preventDefault(); dz.classList.add('pc-drag'); }));
  ['dragleave'].forEach(ev=>dz.addEventListener(ev,e=>{ e.preventDefault(); dz.classList.remove('pc-drag'); }));
  dz.addEventListener('drop',e=>{ e.preventDefault(); dz.classList.remove('pc-drag'); const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) handleFile(f); });
})();

// ---- MediaPipe Pose 遅延ロード ----
async function ensurePose(){
  if(poseLandmarker) return;
  showLoading('AIモデルを初期化しています…（初回のみ数秒）');
  const vision=await import(`${VISION}/vision_bundle.mjs`);
  const fileset=await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  poseLandmarker=await vision.PoseLandmarker.createFromOptions(fileset,{
    baseOptions:{ modelAssetPath:POSE_MODEL }, runningMode:'IMAGE', numPoses:1,
  });
}

// ---- 問診UI ----
function buildQuestions(){
  const wrap=$('#pc-questions-list'); wrap.innerHTML='';
  QUESTIONS.forEach((q,qi)=>{
    const fs=document.createElement('fieldset'); fs.className='pc-q';
    const hint = QUESTION_HINTS[q.id] ? `<p class="pc-q-hint">${QUESTION_HINTS[q.id]}</p>` : '';
    fs.innerHTML=`<legend>Q${qi+1}. ${q.q}</legend><img class="pc-q-strip" src="assets/q-${q.id}.png" alt="" loading="lazy" onerror="this.remove()">${hint}`;
    const opts=document.createElement('div'); opts.className='pc-opts';
    q.o.forEach((op,oi)=>{
      const lab=document.createElement('label'); lab.className='pc-opt';
      lab.innerHTML=`<input type="radio" name="q${qi}" value="${oi}"><span>${op.t}</span>`;
      opts.appendChild(lab);
    });
    const skip=document.createElement('label'); skip.className='pc-opt pc-opt-skip';
    skip.innerHTML=`<input type="radio" name="q${qi}" value="skip"><span>ピンとこない（スキップ）</span>`;
    opts.appendChild(skip);
    fs.appendChild(opts); wrap.appendChild(fs);
  });
  wrap.addEventListener('change', updateProgress);
  updateProgress();
}
function updateProgress(){
  const total=QUESTIONS.length;
  const done=QUESTIONS.filter((q,qi)=>document.querySelector(`input[name="q${qi}"]:checked`)).length;
  $('#pc-progress-bar').style.width=(done/total*100)+'%';
  $('#pc-progress-text').textContent=`${done} / ${total} 問`;
}

// 写真から「重心(Q3)・首肩(Q7)」を自動回答し、その質問は画面から隠す（信頼できる範囲だけ写真化）
function clearAutoAnswers(){
  document.querySelectorAll('#pc-questions-list fieldset.pc-q-auto').forEach(fs=>{ fs.style.display=''; fs.classList.remove('pc-q-auto'); });
  const old=$('#pc-auto-note'); if(old) old.remove();
}
// 写真アップ時: 重心(Q3/idx2)・首肩(Q7/idx6)を隠す（診断ボタンで写真から判定）
function markPhotoQuestionsPending(){
  clearAutoAnswers();
  [2,6].forEach(qi=>{ const fs=document.querySelector(`input[name="q${qi}"]`)?.closest('fieldset'); if(fs){ fs.classList.add('pc-q-auto'); fs.style.display='none'; } });
  const list=$('#pc-questions-list');
  const n=document.createElement('div'); n.id='pc-auto-note'; n.className='pc-auto-note';
  n.innerHTML='📸 重心・首肩のバランスは<b>写真から自動判定</b>します（「診断する」で解析）。残りの質問にお答えください。';
  list.parentNode.insertBefore(n, list);
  updateProgress();
}
// 診断時: 写真から重心(Q3)・首肩(Q7)を埋める。取れなかった項目は隠さず表示して回答を促す。
function fillPhotoAnswers(p){
  const auto={};
  if(p && p.ok){
    if(p.juushin!=null) auto[2]=p.juushin<=0.55?0:p.juushin>=0.70?1:2; // 0=上(S)/1=下(W)/2=均等(N)
    auto[6]=p.shRatio>=1.05?2:p.shRatio<=0.95?1:0;                     // 2=肩広(N)/1=肩狭(W)/0=肩厚(S)
  }
  Object.keys(auto).forEach(qi=>{ const r=document.querySelector(`input[name="q${qi}"][value="${auto[qi]}"]`); if(r) r.checked=true; });
  const stranded=[2,6].filter(qi=>{
    const fs=document.querySelector(`input[name="q${qi}"]`).closest('fieldset');
    return fs.style.display==='none' && !document.querySelector(`input[name="q${qi}"]:checked`);
  });
  if(stranded.length){
    stranded.forEach(qi=>{ const fs=document.querySelector(`input[name="q${qi}"]`).closest('fieldset'); fs.style.display=''; fs.classList.remove('pc-q-auto'); });
    const note=$('#pc-auto-note'); if(note) note.innerHTML='📸 写真から一部読み取れませんでした。表示された質問にもお答えください。';
  }
  updateProgress();
  return stranded.length;
}

// ---- 診断（写真があれば、このボタンで解析して質問と統合） ----
$('#pc-diagnose').addEventListener('click', async()=>{
  // 写真があり未解析なら、ここで解析してQ3/Q7を自動回答
  if(state.loaded && !state.pose){
    try{
      await ensurePose();
      showLoading('写真を解析して総合診断します…');
      const res=poseLandmarker.detect(state.canvas);
      const lm=res.landmarks&&res.landmarks[0];
      state.pose = lm ? extractPose(lm) : { ok:false };
      hideLoading();
    }catch(err){ console.error(err); hideLoading(); state.pose={ ok:false }; }
    const stranded=fillPhotoAnswers(state.pose);
    if(stranded){ alert('写真から重心・首肩が読み取れなかった項目があります。表示された質問にもお答えのうえ、もう一度「診断する」を押してください。'); return; }
  }
  const answers=QUESTIONS.map((q,qi)=>{
    const sel=document.querySelector(`input[name="q${qi}"]:checked`);
    if(!sel || sel.value==='skip') return null;
    return { type:q.o[+sel.value].type, w:q.w };
  });
  const answered=answers.filter(Boolean).length;
  if(answered<8){ alert('できるだけ多く（最低8問）お答えください。現在 '+answered+' 問です。'); return; }
  const result=diagnose(answers, (state.pose && state.pose.ok) ? state.pose : null);
  // 発表演出: 少し溜めてからフェードインで結果を出す
  showLoading('あなたの骨格タイプを診断しています…');
  setTimeout(()=>{
    hideLoading();
    renderResult(result);
    const res=$('#pc-result'); res.hidden=false;
    res.classList.remove('pc-reveal'); void res.offsetWidth; res.classList.add('pc-reveal');
    res.scrollIntoView({behavior:'smooth',block:'start'});
  }, 1200);
});

// ---- 結果描画 ----
function renderResult(r){
  const t=TYPES[r.first], s2=TYPES[r.second];
  const b=t.bridal;
  const hasBooking = BOOKING_URL && BOOKING_URL!=='#';
  const ctaHtml = hasBooking ? `<div class="pc-cta"><span class="pc-cta-label">NEXT STEP</span><h4>この骨格で、あなただけのドレス選びを。</h4><a class="lx-btn lx-btn-gold" href="${BOOKING_URL}" target="_blank" rel="noopener">無料で相談・試着を予約する</a></div>` : '';
  const confMap={high:['高','#6FA04E'],medium:['中','#D6A85E'],low:['参考','#C57B6A']};
  const [cf,cc]=confMap[r.confidence];
  const notes=r.confNotes&&r.confNotes.length?`<p class="pc-confnote">確からしさに影響した点：${r.confNotes.join('／')}</p>`:'';
  const titleLine = r.mixed
    ? `${t.name}寄りのミックス <small>(${t.name}×${s2.name})</small>`
    : `${t.name} <small>(${t.en})</small>`;
  const mixText = MIX_COMBO[`${r.first}_${r.second}`] || (MIX_HINT[r.first]||'').replace('{2nd}', s2.name);
  const mixHint = r.mixed ? `<p class="pc-res-personal">${mixText}</p>` : '';
  // 自分ごと感: アップ写真にAIが読み取ったラインを重ねて表示
  const juTxt = (state.pose && state.pose.juushin!=null) ? (state.pose.juushin<=0.55?'上重心（ウエスト高め）':state.pose.juushin>=0.70?'下重心（ウエスト低め）':'バランス型') : null;
  const frameBlock = (r.photoUsed && state.pose && state.pose.points) ? `<div class="pc-block pc-myframe"><h4>AIが読み取った“あなた”のバランス</h4>
      <canvas id="pc-pose-canvas" class="pc-pose-canvas"></canvas>
      <p class="pc-tip"><span class="pc-fr-sh">肩のライン</span>と<span class="pc-fr-hip">ヒップのライン</span>を検出。肩/ヒップ比 ${state.pose.shRatio.toFixed(2)}${juTxt?` ・重心は${juTxt}`:''}。<br><small>写真は端末内だけで処理し、外部には送信していません。</small></p></div>` : '';

  $('#pc-result-body').innerHTML=`
    <div class="pc-res-head" style="--sa:${t.accent}">
      <div class="pc-res-season">${t.emoji} あなたの骨格タイプは</div>
      <h3 class="pc-res-type">${titleLine}</h3>
      <p class="pc-res-catch">${t.catch}</p>
      <span class="pc-conf" style="background:${cc}">診断の確からしさ：${cf}</span>
    </div>
    <div class="pc-res-method-wrap"><span class="pc-res-method">${r.photoUsed?'📸 写真 ＋ 📝 質問 の両方から総合診断しました':'📝 質問への回答から診断しました'}</span></div>
    <p class="pc-res-charm">${t.charm}</p>
    ${mixHint}
    <p class="pc-res-desc">${t.desc}</p>

    <div class="pc-block"><h4>あなたの骨格の特徴</h4>
      <ul>${t.characteristics.map(x=>`<li>${x}</li>`).join('')}</ul></div>

    ${frameBlock}

    <div class="pc-block pc-principle"><h4>似合わせの軸</h4><p>${t.principle}</p></div>

    <div class="pc-wedding">
      <div class="pc-wedding-head">
        <span class="pc-wd-label">FOR YOUR WEDDING</span>
        <h4>あなたに似合うウェディングドレス</h4>
        <p class="pc-wd-theme">${t.catch}</p>
      </div>
      <img class="pc-type-img" src="assets/type-${r.first}.png" alt="${t.name}に似合うドレス" onerror="this.style.display='none'">
      <div class="pc-wd-grid">
        <div class="pc-wd-card"><b>👗 シルエット</b><p>${b.silhouette}</p></div>
        <div class="pc-wd-card"><b>💠 ネックライン</b><p>${b.neckline}</p></div>
        <div class="pc-wd-card"><b>🧵 素材・装飾</b><p>${b.material}</p></div>
        <div class="pc-wd-card"><b>💐 ブーケ</b><p>${b.bouquet}</p></div>
        <div class="pc-wd-card"><b>💇‍♀️ ヘア</b><p>${b.hair}</p></div>
        <div class="pc-wd-card"><b>💍 アクセサリー</b><p>${b.accessory}</p></div>
        <div class="pc-wd-card"><b>📷 前撮りロケ</b><p>${b.photo}</p></div>
        <div class="pc-wd-card"><b>🥂 二次会ドレス</b><p>${b.second}</p></div>
        <div class="pc-wd-card"><b>👘 和装</b><p>${t.kimono}</p></div>
        <div class="pc-wd-card"><b>🚫 避けたいデザイン</b><p>${b.avoid}</p></div>
      </div>
    </div>

    <div class="pc-info">
      <div><b>得意なアイテム</b>${t.items.good}</div>
      <div><b>苦手なアイテム</b>${t.items.bad}</div>
    </div>
    <p class="pc-tip">苦手なアイテムも、${t.wearTip}</p>

    <div class="pc-block"><h4>2番目に近いタイプ</h4>
      <p class="pc-second-ref"><b>${s2.name}</b>${r.mixed?'（ミックスの第2タイプ）':''}：${s2.bridal.silhouette}<br><small>${MIX_HINT[r.first] ? '上の「ミックス」のヒントも参考に、'+s2.name+'の要素を一点だけ取り入れても素敵です。' : ''}</small></p></div>

    <div class="pc-block pc-why"><h4>判定の根拠</h4><ul>${r.reasons.map(x=>`<li>${x}</li>`).join('')}</ul>${notes}</div>

    <div class="pc-cross">
      <h4>さらに“似合う”を完成させるなら</h4>
      <p>骨格は<b>似合うシルエット</b>。これに<b>似合う色（パーソナルカラー）</b>を掛け合わせると、ドレス選びが完成します。</p>
      <a class="lx-btn lx-btn-ghost" href="${COLORIA_URL}" target="_blank" rel="noopener">パーソナルカラー診断もする（無料）</a>
    </div>

    ${ctaHtml}

    <p class="pc-disclaimer">※ これは問診（と任意の写真）からの<strong>簡易的な目安</strong>です。特定団体（骨格スタイル協会・ICBI等）とは無関係・非公認で、専門家の対面診断に代わるものではありません。骨格診断は美容実務上の分類で、医学的・科学的診断ではありません。</p>
    <div class="pc-actions">
      <button class="lx-btn lx-btn-ghost" id="pc-save">結果を画像で保存</button>
      <button class="lx-btn lx-btn-ghost" id="pc-print">印刷 / PDF</button>
      <button class="lx-btn lx-btn-green" id="pc-restart">もう一度診断する</button>
    </div>
  `;
  if(r.photoUsed) drawPoseAnalysis($('#pc-pose-canvas'));
  $('#pc-save').addEventListener('click',()=>makeResultCard(r));
  $('#pc-print').addEventListener('click',()=>window.print());
  $('#pc-restart').addEventListener('click',restart);
}

// ---- アップ写真にAIが読み取ったライン(肩/ヒップ/重心)を重ねて描画 ----
function drawPoseAnalysis(cv){
  if(!cv || !state.imageData || !(state.pose&&state.pose.points)) return;
  const W=state.W, H=state.H, p=state.pose.points;
  const outW=300, outH=Math.max(40, Math.round(outW*H/W));
  cv.width=outW; cv.height=outH;
  const c=cv.getContext('2d');
  const off=document.createElement('canvas'); off.width=W; off.height=H;
  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(state.imageData),W,H),0,0);
  c.drawImage(off,0,0,W,H,0,0,outW,outH);
  const X=x=>x*outW, Y=y=>y*outH;
  const line=(a,b,col)=>{ if(!a||!b) return; c.strokeStyle=col; c.lineWidth=3; c.lineCap='round';
    c.beginPath(); c.moveTo(X(a.x),Y(a.y)); c.lineTo(X(b.x),Y(b.y)); c.stroke();
    [a,b].forEach(q=>{ c.fillStyle='#fff'; c.beginPath(); c.arc(X(q.x),Y(q.y),4,0,Math.PI*2); c.fill(); c.lineWidth=1.5; c.strokeStyle='rgba(71,63,54,.3)'; c.stroke(); }); };
  line(p.sL,p.sR,'rgba(196,139,166,.95)'); // 肩=ローズ
  line(p.hL,p.hR,'rgba(126,140,106,.95)'); // ヒップ=セージ
  // 重心の目安ライン（肩中点と腰中点の中間あたりに横ライン）
  if(p.sL&&p.sR&&p.hL&&p.hR){
    const my=( (p.sL.y+p.sR.y)/2*0.35 + (p.hL.y+p.hR.y)/2*0.65 );
    c.strokeStyle='rgba(180,138,94,.6)'; c.lineWidth=1.5; c.setLineDash([5,5]);
    c.beginPath(); c.moveTo(outW*0.12,Y(my)); c.lineTo(outW*0.88,Y(my)); c.stroke(); c.setLineDash([]);
  }
}

// ---- 結果を画像カードで保存 ----
function wrapText(ctx, text, x, y, maxW, lh){
  let line='';
  for(const ch of [...String(text)]){
    if(ctx.measureText(line+ch).width>maxW && line){ ctx.fillText(line,x,y); line=ch; y+=lh; }
    else line+=ch;
  }
  if(line) ctx.fillText(line,x,y);
  return y+lh;
}
function makeResultCard(r){
  const t=TYPES[r.first], b=t.bridal;
  const W=720, H=1100, cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const c=cv.getContext('2d');
  c.fillStyle='#FAF6EF'; c.fillRect(0,0,W,H);
  c.strokeStyle='#E6DCCB'; c.lineWidth=2; c.strokeRect(24,24,W-48,H-48);
  c.textAlign='center';
  let y=92;
  c.fillStyle='#9a7b5c'; c.font='600 24px Georgia, serif'; c.fillText('Ligne Atelier', W/2, y); y+=46;
  c.fillStyle='#b08a5e'; c.font='13px sans-serif'; c.fillText('YOUR SKELETAL TYPE', W/2, y); y+=50;
  const title = r.mixed ? `${t.name}寄りのミックス` : t.name;
  c.fillStyle='#46402f'; c.font='700 42px serif'; c.fillText(title, W/2, y); y+=34;
  c.fillStyle='#b07a5b'; c.font='italic 18px serif'; c.fillText(t.catch, W/2, y); y+=34;
  c.strokeStyle='#E6DCCB'; c.beginPath(); c.moveTo(W/2-60,y); c.lineTo(W/2+60,y); c.stroke(); y+=44;
  c.textAlign='left'; const x=72, maxW=W-144;
  const sec=(label, text)=>{ c.fillStyle='#9a7b5c'; c.font='700 16px sans-serif'; c.fillText(label, x, y); y+=28; c.fillStyle='#4a4030'; c.font='15px sans-serif'; y=wrapText(c, text, x, y, maxW, 26)+14; };
  sec('似合わせの軸', t.principle);
  sec('似合うドレスのシルエット', b.silhouette);
  sec('ネックライン', b.neckline);
  sec('素材・装飾', b.material);
  sec('似合うブーケ', b.bouquet);
  sec('得意なアイテム', t.items.good);
  sec('避けたいデザイン', b.avoid);
  c.textAlign='center'; c.fillStyle='#9a8f7e'; c.font='11px sans-serif';
  c.fillText('※ 簡易的な目安です。特定団体とは無関係・非公認。', W/2, H-58);
  c.fillText('Ligne Atelier — 似合うシルエットを、骨格から。', W/2, H-38);
  const a=document.createElement('a'); a.download=`骨格診断_${t.name}.png`; a.href=cv.toDataURL('image/png'); a.click();
}

function restart(){
  state.features=null; state.loaded=false; state.pose=null;
  $('#pc-file').value='';
  $('#pc-preview').hidden=true;
  document.querySelectorAll('input[type=radio]').forEach(r=>r.checked=false);
  clearAutoAnswers();
  updateProgress();
  $('#pc-result').hidden=true;
  window.scrollTo({top:0,behavior:'smooth'});
}

buildQuestions();
