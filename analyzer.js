// ===================================================================
// 骨格: MediaPipe Pose Landmarker(33点) から肩/ヒップ比を抽出
// 出典: _knowledge/03。写真は弱補助（質感・骨感は写真で取れない）。
// landmark: 11左肩 12右肩 23左腰 24右腰 27左足首 28右足首
// ===================================================================

export function extractPose(lm){
  const need=[11,12,23,24];
  const ok = need.every(i=> lm[i] && (lm[i].visibility===undefined || lm[i].visibility>0.4));
  if(!ok) return { ok:false, reason:'肩・腰が検出できません（明るく全身・正面でお試しください）' };
  const shoulderW=Math.abs(lm[11].x-lm[12].x);
  const hipW=Math.abs(lm[23].x-lm[24].x);
  if(hipW<0.02 || shoulderW<0.02) return { ok:false, reason:'肩・腰の幅が取れません（全身がはっきり写る写真で）' };
  const shRatio=shoulderW/hipW;
  // 重心: 胴(肩〜腰)と脚(腰〜足首)の比。小=上重心 / 大=下重心
  const shoulderY=(lm[11].y+lm[12].y)/2, hipY=(lm[23].y+lm[24].y)/2;
  const ankVis = lm[27]&&lm[28]
    && (lm[27].visibility===undefined||lm[27].visibility>0.3)
    && (lm[28].visibility===undefined||lm[28].visibility>0.3);
  let juushin=null;
  if(ankVis){
    const ankleY=(lm[27].y+lm[28].y)/2;
    if(ankleY>hipY && hipY>shoulderY) juushin=(hipY-shoulderY)/(ankleY-hipY);
  }
  const fullBody=!!ankVis;
  const warnings=[];
  if(!fullBody) warnings.push('足首まで写っていれば重心まで解析できます');
  if(shRatio>1.6 || shRatio<0.6) warnings.push('比率が極端（斜め/手を広げている可能性）');
  return { ok:true, shRatio, juushin, shoulderW, hipW, fullBody, warnings };
}
