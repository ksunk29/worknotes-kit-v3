#!/usr/bin/env node
// CSV 관찰 도구 (의존성 없음, Node 18+)
// 사용: node kit/tools/profile-csv.mjs <파일.csv> [--key <열이름>] [--delimiter ,]
//
// 출력은 '관찰 결과'이며 오류 판정이 아닙니다. 값을 고치거나 파일을 바꾸지 않습니다.
// 같은 키가 여러 번 나오는 것, 빈 값, 열 개수가 다른 행은 정상 데이터일 수도 있으니 업무 기준은 담당자에게 확인하세요.
import fs from 'node:fs';

export function parseCsv(text, delimiter = ',') {
  return parseCsvDetailed(text, delimiter).rows;
}

// 행과 함께 '구조 경고'를 돌려준다. 값은 고치지 않고, 의심스러운 따옴표만 알린다.
export function parseCsvDetailed(text, delimiter = ',') {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [], startLines = [], warnings = [];
  let row = [], cur = '', quoted = false, any = false;
  let line = 1, recStart = 1, quoteOpenLine = 0, fieldStart = true;
  const endRow = () => {
    if (any || cur !== '' || row.length) { row.push(cur); rows.push(row); startLines.push(recStart); }
    row = []; cur = ''; any = false; fieldStart = true;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') {
        quoted = false;
        const n = text[i + 1];
        if (n !== undefined && n !== delimiter && n !== '\n' && n !== '\r') {
          warnings.push(`줄 ${line}: 닫는 따옴표 뒤에 다른 문자가 이어짐`);
        }
      } else { cur += c; if (c === '\n') line++; }
    } else if (c === '"') {
      if (fieldStart) { quoted = true; quoteOpenLine = line; any = true; }
      else { cur += c; warnings.push(`줄 ${line}: 값 중간에 따옴표가 있음 (글자 그대로 읽음)`); }
      fieldStart = false;
    } else if (c === delimiter) { row.push(cur); cur = ''; any = true; fieldStart = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow(); line++; recStart = line;
    } else { cur += c; any = true; fieldStart = false; }
  }
  if (quoted) warnings.push(`줄 ${quoteOpenLine}: 따옴표가 닫히지 않아 파일 끝까지 한 값으로 읽힘`);
  endRow();
  return { rows, startLines, warnings };
}

// 대소문자·공백·하이픈·밑줄만 다른 값을 묶어 보여 준다. 같은 대상인지는 판단하지 않는다.
// 글자가 들어 있는 값만 본다(날짜·숫자 형식 차이는 제외).
export function spellingVariants(values, limit = 5) {
  const groups = new Map();
  for (const v of new Set(values)) {
    if (!/[A-Za-z가-힣]/.test(v)) continue;
    const key = v.toLowerCase().replace(/[\s_-]+/g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return [...groups.values()].filter((g) => g.length > 1).slice(0, limit);
}

export function profile(text, { key, delimiter = ',' } = {}) {
  const { rows, startLines, warnings } = parseCsvDetailed(text, delimiter);
  if (!rows.length) return { empty: true, warnings };
  const header = rows[0];
  const body = rows.slice(1);
  const width = header.length;
  const widthMismatch = [];
  body.forEach((r, i) => { if (r.length !== width) widthMismatch.push({ line: startLines[i + 1], record: i + 2, cells: r.length }); });
  const seen = new Map();
  let exactDup = 0;
  for (const r of body) {
    const k = JSON.stringify(r);
    if (seen.has(k)) exactDup++; else seen.set(k, 1);
  }
  const columns = header.map((name, c) => {
    const vals = body.map((r) => r[c]).filter((v) => v !== undefined);
    const empty = vals.filter((v) => v === '').length;
    const nonEmpty = vals.filter((v) => v !== '');
    const numeric = nonEmpty.filter((v) => Number.isFinite(Number(v)) && v.trim() !== '').length;
    return { name, empty, distinct: new Set(nonEmpty).size, numeric, nonEmpty: nonEmpty.length, variants: spellingVariants(nonEmpty) };
  });
  let keyInfo = null;
  if (key) {
    const idx = header.indexOf(key);
    if (idx < 0) keyInfo = { error: `열 '${key}' 없음` };
    else {
      const counts = new Map();
      for (const r of body) counts.set(r[idx], (counts.get(r[idx]) || 0) + 1);
      const repeated = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
      keyInfo = { key, distinct: counts.size, repeated: repeated.length, top: repeated.slice(0, 5) };
    }
  }
  return { rows: body.length, width, header, widthMismatch, exactDup, columns, keyInfo, warnings };
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--key' && args[args.indexOf(a) - 1] !== '--delimiter');
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!file) { console.error('사용: node profile-csv.mjs <파일.csv> [--key <열이름>] [--delimiter ,]'); process.exit(2); }
  const p = profile(fs.readFileSync(file, 'utf8'), { key: opt('--key'), delimiter: opt('--delimiter') || ',' });
  if (p.empty) { console.log(`${file}: 비어 있음`); return; }
  console.log(`파일: ${file}`);
  if (p.warnings.length) {
    console.log(`\n[구조 경고] 따옴표가 의심스러워 아래 결과를 믿기 어렵습니다 (${p.warnings.length}건):`);
    for (const w of p.warnings.slice(0, 5)) console.log(`  - ${w}`);
    if (p.warnings.length > 5) console.log('  ...');
    console.log('  원본을 직접 확인한 뒤 해석하세요.\n');
  }
  console.log(`행 수(헤더 제외): ${p.rows}, 열 수: ${p.width}`);
  console.log(`열: ${p.header.join(', ')}`);
  console.log(`열 개수가 헤더와 다른 행: ${p.widthMismatch.length}${p.widthMismatch.length ? ` (시작 줄 ${p.widthMismatch.slice(0, 5).map((m) => `${m.line}:${m.cells}칸`).join(', ')}${p.widthMismatch.length > 5 ? ' ...' : ''})` : ''}`);
  console.log(`완전히 같은 행의 중복 수: ${p.exactDup}`);
  console.log('열별 요약 (빈 값 / 고유 값 / 숫자로 읽히는 값 / 비어 있지 않은 값):');
  for (const c of p.columns) console.log(`  - ${c.name}: ${c.empty} / ${c.distinct} / ${c.numeric} / ${c.nonEmpty}`);
  const withVariants = p.columns.filter((c) => c.variants.length);
  if (withVariants.length) {
    console.log('표기만 다른 값 묶음 (대소문자·공백·하이픈·밑줄 차이. 같은 대상인지는 담당자에게 확인):');
    for (const c of withVariants) console.log(`  - ${c.name}: ${c.variants.map((g) => g.join(' / ')).join(' | ')}`);
  }
  if (p.keyInfo) {
    if (p.keyInfo.error) console.log(`키: ${p.keyInfo.error}`);
    else console.log(`키 '${p.keyInfo.key}': 고유 값 ${p.keyInfo.distinct}, 2번 이상 나온 값 ${p.keyInfo.repeated}${p.keyInfo.top.length ? ` (상위: ${p.keyInfo.top.map(([k, n]) => `${k}×${n}`).join(', ')})` : ''}`);
  }
  console.log('\n※ 위 내용은 관찰 결과입니다. 오류 여부와 처리 기준은 담당자에게 확인하세요.');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
