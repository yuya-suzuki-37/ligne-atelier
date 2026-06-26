// ===================================================================
// 骨格診断 判定ロジック（仕様: _knowledge/08）
// 写真は「重心・首肩バランス」の該当質問を自動回答する形でanswersに統合済み。
// → ここでは全回答(写真由来＋自己申告)を重み付き集計するだけ（二重計上なし）。
// ===================================================================
import { TYPES, TYPE_ORDER } from './data.js';

export function diagnose(answers, photo){
  const photoUsed = !!(photo && photo.ok);
  const pts={straight:0,wave:0,natural:0};
  let answered=0;
  for(const a of (answers||[])){
    if(!a) continue;
    pts[a.type]+=a.w; answered++;
  }

  const sum=TYPE_ORDER.reduce((s,t)=>s+pts[t],0)||1;
  const ranked=TYPE_ORDER.map(t=>({t, v:pts[t], share:pts[t]/sum})).sort((a,b)=>b.v-a.v);
  const first=ranked[0], second=ranked[1];
  const margin = first.v>0 ? (first.v-second.v)/first.v : 0;
  const mixed = margin < 0.15;

  // 信頼度
  let conf=0; const notes=[];
  if(margin>=0.25) conf++; else notes.push('1位と2位が僅差（ミックスの可能性）');
  if(answered>=12) conf++; else if(answered<8){ conf--; notes.push('回答が少なめ'); } else notes.push('もう少し回答すると精度が上がります');
  if(photoUsed) conf++; else notes.push('全身写真を加えると、重心・首肩を写真から自動判定できます');
  const confidence = conf>=2?'high':conf>=1?'medium':'low';

  // 根拠
  const reasons=[];
  if(photoUsed){
    reasons.push('📸 写真から：重心・首肩のバランスを自動判定');
    reasons.push('📝 質問から：質感・骨格などのご回答を集計');
    reasons.push(`→ 写真と質問の両方を総合して「${TYPES[first.t].name}」と判定（2位「${TYPES[second.t].name}」との差 ${Math.round(margin*100)}%）`);
  } else {
    reasons.push('📝 質問への回答を集計');
    reasons.push(`→ 総合して「${TYPES[first.t].name}」と判定（2位「${TYPES[second.t].name}」との差 ${Math.round(margin*100)}%）。全身写真を加えると重心・首肩を写真から自動判定できます`);
  }
  if(mixed) reasons.push(`1位と2位が僅差のため「${TYPES[first.t].name}寄りのミックス（${TYPES[first.t].name}×${TYPES[second.t].name}）」としてご提案します`);

  return {
    first:first.t, second:second.t, mixed,
    share:Object.fromEntries(ranked.map(r=>[r.t,r.share])),
    confidence, confNotes:notes, reasons, photoUsed,
  };
}
