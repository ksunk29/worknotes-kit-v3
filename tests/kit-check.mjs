import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseCsvDetailed, profile, spellingVariants } from '../tools/profile-csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDirs = () => fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); // .DS_Store 같은 파일은 제외
const tmp = (p = 'kit-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (args, opts = {}) => spawnSync('sh', args, { encoding: 'utf8', ...opts });
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p) + (e.isDirectory() ? '/' : ':' + fs.readFileSync(p, 'utf8').length)); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort().join('\n');
};

// ───────── 형식 검사 ─────────
test('스킬: name/description 존재, name=폴더명, 본문 길이 상한', () => {
  const dirs = skillDirs();
  assert.ok(dirs.length >= 3);
  for (const d of dirs) {
    const text = fs.readFileSync(path.join(ROOT, 'skills', d, 'SKILL.md'), 'utf8');
    const m = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(m, `${d}: frontmatter 형식`);
    assert.equal(m[1].trim(), d, `${d}: name 이 폴더명과 같아야 함`);
    assert.ok(m[2].includes('사용하지 않는다'), `${d}: description 에 '쓰지 않을 때'가 있어야 함`);
    assert.ok(text.length < 2500, `${d}: 너무 김 (${text.length})`);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'skills', d)), ['SKILL.md'], `${d}: 동반 파일 없음`);
  }
});

test('지침: AGENTS.md 와 working-rules.md 동일, 크기·중복·참조 경로 점검', () => {
  const a = fs.readFileSync(path.join(ROOT, 'instructions/AGENTS.md'), 'utf8');
  assert.equal(a, fs.readFileSync(path.join(ROOT, 'instructions/working-rules.md'), 'utf8'));
  assert.ok(Buffer.byteLength(a) < 4300, `AGENTS.md 가 큼: ${Buffer.byteLength(a)}B`); // 내부 목표(토큰 절약), 공식 요건 아님. 공식 한도는 32KiB. v2에서 기준선·병렬 규칙을 넣어 3800 → 4300
  const lines = a.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(new Set(lines).size, lines.length, '중복 규칙 없음');
  for (const m of a.matchAll(/`kit\/(skills\/[^`]+\/SKILL\.md)`/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `참조 파일 없음: ${m[1]}`);
  // 자동 로딩을 보장하는 것처럼 쓰지 않는다
  assert.match(a, /자동으로 적용되지 않으면/);
});

test('install.sh: POSIX 문법 (sh, dash)', () => {
  for (const shell of ['sh', 'dash']) {
    const r = spawnSync(shell, ['-n', path.join(ROOT, 'install.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
  }
  for (const f of ['install.sh', 'tools/evidence.sh']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\[\[|pipefail|\bdeclare\b|\blocal\b/, `${f}: bash 전용 문법`);
});

test('저장소 전체에 비밀값 패턴이 없다', () => {
  const re = /(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(ROOT)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), re, f);
});

// ───────── install.sh 동작 ─────────
test('check: 아무 파일도 바꾸지 않는다 (홈 포함)', () => {
  const work = tmp(), home = tmp('home-');
  const before = snapshot(work) + '|' + snapshot(home);
  const r = sh([path.join(ROOT, 'install.sh'), 'check'], { cwd: work, env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /바꾸지 않습니다/);
  assert.equal(snapshot(work) + '|' + snapshot(home), before);
});

test('agents: AGENTS.md 가 없을 때만 복사, 있으면 변경 없음', () => {
  const work = tmp();
  assert.equal(sh([path.join(ROOT, 'install.sh'), 'agents'], { cwd: work }).status, 0);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(ROOT, 'instructions/AGENTS.md'), 'utf8'));
  const work2 = tmp();
  fs.writeFileSync(path.join(work2, 'AGENTS.md'), '기존 지침\n');
  const r = sh([path.join(ROOT, 'install.sh'), 'agents'], { cwd: work2 });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(work2, 'AGENTS.md'), 'utf8'), '기존 지침\n', '덮어쓰거나 덧붙이지 않음');
  assert.match(r.stdout, /working-rules\.md/);
});

test('skills: 복사하고, 재실행해도 같은 결과이며 다른 내용은 덮어쓰지 않는다', () => {
  const work = tmp();
  const first = sh([path.join(ROOT, 'install.sh'), 'skills'], { cwd: work });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  for (const d of skillDirs()) assert.ok(fs.existsSync(path.join(work, '.agents/skills', d, 'SKILL.md')));
  const snap = snapshot(work);
  assert.equal(sh([path.join(ROOT, 'install.sh'), 'skills'], { cwd: work }).status, 0);
  assert.equal(snapshot(work), snap, '재실행 멱등');
  const custom = path.join(work, '.agents/skills/work-intake/SKILL.md');
  fs.writeFileSync(custom, '내가 고친 내용');
  const r = sh([path.join(ROOT, 'install.sh'), 'skills'], { cwd: work });
  assert.match(r.stdout, /덮어쓰지 않음/);
  assert.equal(fs.readFileSync(custom, 'utf8'), '내가 고친 내용');
});

test('skills: 쓸 수 없으면 우회하지 않고 실패·안내 (읽기 전용 폴더로 재현. 실제 샌드박스 보호와는 다를 수 있음)', { skip: process.getuid?.() === 0 }, () => {
  const work = tmp();
  fs.chmodSync(work, 0o555);
  try {
    const r = sh([path.join(ROOT, 'install.sh'), 'skills'], { cwd: work });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /대체 방법/);
    assert.match(r.stdout, /우회/);
    assert.equal(fs.existsSync(path.join(work, '.agents')), false, '다른 경로로 돌파하지 않음');
  } finally { fs.chmodSync(work, 0o755); }
});

// ───────── 도구 ─────────
test('profile-csv: 따옴표 안 쉼표·줄바꿈, BOM, CRLF 처리', () => {
  const rows = parseCsv('﻿a,b\r\n1,"x,y"\r\n2,"line1\nline2"\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', 'x,y'], ['2', 'line1\nline2']]);
});

test('profile-csv: 관찰만 출력 (열 개수 불일치, 빈 값, 완전 중복, 키 반복)', () => {
  const p = profile('id,name,amt\n1,a,10\n1,b,\n2,c,x\n2,c,x\n3,d\n', { key: 'id' });
  assert.equal(p.rows, 5);
  assert.deepEqual(p.widthMismatch, [{ line: 6, record: 6, cells: 2 }]);
  assert.equal(p.exactDup, 1);
  const amt = p.columns.find((c) => c.name === 'amt');
  assert.equal(amt.empty, 1);
  assert.equal(amt.numeric, 1);
  assert.equal(p.keyInfo.repeated, 2);
  assert.ok(!('errors' in p), '오류 판정 필드 없음');
});

test('profile-csv: CLI는 원본 파일을 바꾸지 않는다', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.csv');
  fs.writeFileSync(f, 'k,v\n1,2\n1,2\n');
  const r = spawnSync('node', [path.join(ROOT, 'tools/profile-csv.mjs'), f, '--key', 'k'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /관찰 결과입니다/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'k,v\n1,2\n1,2\n');
});

test('evidence.sh: 종료 코드 보존, 출력이 없어도 성공으로 오판하지 않음, 비밀값 처리', () => {
  const dir = tmp();
  const ev = path.join(ROOT, 'tools/evidence.sh');
  const log = path.join(dir, 'V.md');
  const fail = sh([ev, '-o', log, '--', 'sh', '-c', 'exit 7']);
  assert.equal(fail.status, 7, '실패 코드가 그대로 반환되어야 함');
  assert.match(fs.readFileSync(log, 'utf8'), /종료 코드: 7 \(명령 실패\)/);
  const silentFail = sh([ev, '-o', log, '--', 'sh', '-c', 'exit 1']); // 출력 없음
  assert.equal(silentFail.status, 1);
  const ok = sh([ev, '-o', log, '--', 'sh', '-c', 'echo done']);
  assert.equal(ok.status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /요구사항 충족 여부와는 별개/);
  // 출력의 비밀값 형태는 가림 (가짜 값은 런타임에 조립해 저장소에 리터럴로 남기지 않는다)
  const fakeKey = 'sk' + '-' + 'a'.repeat(26);
  // 명령 문자열에는 비밀값 형태가 이어져 보이지 않게 쪼개고, 실행 결과(출력)에서만 완성되게 한다.
  sh([ev, '-o', log, '--', 'sh', '-c', `printf '%s%s %s%s\\n' 'tok' 'en=abcdef123456' 'sk-' '${'a'.repeat(26)}'`]);
  const blocks = [...fs.readFileSync(log, 'utf8').matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
  const lastOutput = blocks[blocks.length - 1];
  assert.doesNotMatch(lastOutput, /abcdef123456|a{26}/, '출력의 비밀값 형태는 가려져야 함');
  assert.match(lastOutput, /\[가림\]/);
  // 명령에 비밀값이 있으면 실행하지 않음
  const marker = path.join(dir, 'ran');
  const refuse = sh([ev, '-o', log, '--', 'sh', '-c', `touch ${marker}; echo ${fakeKey}`]);
  assert.equal(refuse.status, 3);
  assert.equal(fs.existsSync(marker), false, '실행되지 않아야 함');
  // 인자 없음
  assert.equal(sh([ev]).status, 2);
});

test('evidence.sh: 기록 저장 실패를 기록 완료로 말하지 않고, 알 수 없는 옵션은 실행하지 않는다', () => {
  const dir = tmp('ev2-');
  const ev = path.join(ROOT, 'tools/evidence.sh');
  const bad = path.join(dir, 'no-such-dir', 'log.md');
  const r = sh([ev, '-o', bad, '--', 'true'], { cwd: dir });
  assert.equal(r.status, 5, '명령은 성공했지만 기록 실패');
  assert.doesNotMatch(r.stdout, /기록 완료/);
  assert.match(r.stderr, /기록 실패/);
  const r2 = sh([ev, '-o', bad, '--', 'sh', '-c', 'exit 7'], { cwd: dir });
  assert.equal(r2.status, 7, '명령이 실패했으면 그 종료 코드를 보존');
  assert.match(r2.stderr, /기록 실패/);
  const r3 = sh([ev, '--help'], { cwd: dir });
  assert.equal(r3.status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'VERIFY.md')), false, '옵션을 명령으로 실행해 기록을 남기면 안 됨');
  const ok = sh([ev, '-o', path.join(dir, 'ok.md'), '--', 'sh', '-c', 'exit 3'], { cwd: dir });
  assert.equal(ok.status, 3);
  assert.match(ok.stdout, /기록 완료/);
});

test('키트의 테스트는 작업 폴더의 `node --test` 기본 탐색에 잡히지 않는다 (실제 사고 재현: 키트 테스트 12개가 사용자 테스트에 섞임)', () => {
  const ws = tmp('ws-');
  fs.cpSync(ROOT, path.join(ws, 'kit'), { recursive: true, filter: (s) => !s.includes('/.git') });
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // 바깥 테스트 러너의 상태가 중첩 실행 출력을 숨기지 않게 한다
  // Node 버전마다 기본 출력 형식이 다르므로(20: tap, 24: spec) tap 으로 고정해 확인한다
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: ws, encoding: 'utf8', env });
  assert.match(r.stdout, /# tests 0\b/, r.stdout.slice(-400));
});

test('지침은 문서를 불필요하게 늘리지 않도록 안내한다', () => {
  const a = fs.readFileSync(path.join(ROOT, 'instructions/AGENTS.md'), 'utf8');
  assert.match(a, /별도 문서는 과제가 클 때만/);
  assert.match(a, /과한 방어 코드/);
});

test('지침: 미확인 기준은 잠정 구현+표시, 필드를 채우려고 값을 만들어내지 않는다', () => {
  const a = fs.readFileSync(path.join(ROOT, 'instructions/AGENTS.md'), 'utf8');
  assert.match(a, /확인 전 가정/);
  assert.match(a, /명세가 허용하는 미확정·오류 상태/);
  assert.match(a, /필드를 채우려고 사실이나 데이터를 만들어내지 않는다/);
  assert.ok(Buffer.byteLength(a) < 4300, `AGENTS.md ${Buffer.byteLength(a)}바이트`);
  // 미확인 값을 만들어 채우게 유도하던 옛 문장이 어디에도 남지 않아야 한다
  for (const f of ['instructions/AGENTS.md', 'instructions/working-rules.md', 'skills/work-intake/SKILL.md']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(t, /유효한 값으로 채우고/, f);
    assert.doesNotMatch(t, /null(·빈 값)?으로 비우지 않는다/, f);
  }
});

test('work-intake: 문서는 끝까지, 데이터는 샘플+이상 징후 집계, 필요한 파일은 읽기만', () => {
  const w = fs.readFileSync(path.join(ROOT, 'skills/work-intake/SKILL.md'), 'utf8');
  assert.match(w, /\*\*끝까지\*\* 읽는다/);
  assert.match(w, /이상 징후/);
  assert.match(w, /읽은 파일 목록/);
  assert.doesNotMatch(w, /이름과 앞부분만 읽는다/);
});

test('웹 과제: 서버 바인딩·터미널 유지·확인 주체가 지침과 스킬에 있고, 사람용 시간표는 지침이 참조하지 않는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const a = read('instructions/AGENTS.md');
  assert.match(a, /`0\.0\.0\.0`에 바인딩하고 실제 포트를 출력/);
  assert.match(a, /터미널은 닫지 않고 같은 서버를 중복 실행하지 않는다/);
  assert.match(a, /`curl`이나 테스트로, 화면은 허용된 브라우저 자동화\(별도 포트·임시 DB\)와 응시자의 미리보기로 확인한다/);
  assert.match(a, /과제 안내가 우선/);
  assert.match(a, /토큰을 아낀다/);
  const v = read('skills/verify-evidence/SKILL.md');
  assert.match(v, /`curl`이나 테스트로 실제 응답을 확인한다/);
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /화면·사용 흐름/);
  assert.match(w, /맞는지 확인받는다/);
  const pb = read('PLAYBOOK.md');
  assert.match(pb, /`0\.0\.0\.0`/);
  assert.match(pb, /제출을 확정하고 문제풀기/);
  assert.doesNotMatch(a, /PLAYBOOK/, '사람용 문서는 에이전트가 읽지 않게 지침에서 참조하지 않는다');
  assert.equal(read('instructions/working-rules.md'), a);
});

test('web-ui-basics: 상태·정확성·외부 의존 금지·응시자 확인표를 담고, 지침 표에서 참조된다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const w = read('skills/web-ui-basics/SKILL.md');
  assert.match(w, /정상 \/ 불러오는 중 \/ 데이터 없음 \/ 서버 오류 \/ 입력 오류/);
  assert.match(w, /과제가 요구하거나 제공한 연동은 따르고, 그 밖의 CDN·웹폰트·외부 이미지·외부 API는 추가하지 않고/);
  assert.match(w, /응시자가 제공된 미리보기에서 직접 확인하게 한다/);
  assert.match(w, /브라우저 자동화\(Playwright 등\)는 과제 안내가 허용할 때만, 별도 포트·임시 DB·합성 데이터로 실행하고 설치가 막히면 우회하지 않는다/);
  assert.match(w, /자동화 통과는 실제 미리보기 확인이 아니다/);
  assert.match(w, /iframe/);
  assert.doesNotMatch(w, /https?:\/\//, '외부 주소를 넣지 않는다');
  assert.match(read('instructions/AGENTS.md'), /`kit\/skills\/web-ui-basics\/SKILL\.md`/);
});

test('profile-csv: 표기만 다른 값은 묶어서 보여 주되 판단하지 않고, 날짜·숫자 형식 차이는 제외한다', () => {
  assert.deepEqual(spellingVariants(['ETC-07', 'etc07', 'Etc 07', 'ZZ-1']), [['ETC-07', 'etc07', 'Etc 07']]);
  assert.deepEqual(spellingVariants(['2025-10-01', '20251001', '1.0', '1']), []);
  const p = profile('id,site\n1,A_1\n2,a-1\n3,B\n');
  assert.deepEqual(p.columns.find((c) => c.name === 'site').variants, [['A_1', 'a-1']]);
});

test('PLAYBOOK·PROMPTS: 교차 점검은 읽기 전용 프롬프트(5-3)이고 커밋은 선택이며 push는 하지 않는다', () => {
  const pb = fs.readFileSync(path.join(ROOT, 'PLAYBOOK.md'), 'utf8');
  const pr = fs.readFileSync(path.join(ROOT, 'PROMPTS.md'), 'utf8');
  assert.match(pr, /\*\*5-3\. 읽기 전용 교차 점검\*\*/);
  assert.match(pr, /파일을 수정하지 말고/);
  assert.match(pb, /5-3\(high\) 읽기 전용 교차 점검/);
  assert.match(pb, /\(선택\) 내 터미널에서 커밋/);
  assert.match(pr, /Push는 하지 않습니다/);
});

test('문구 정합: 질문은 영향 큰 것부터 구체적으로, 서버 실행은 자동화하지 않되 확인 사항으로 남기고, 커밋이 막히면 우회하지 않는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /결과 영향이 큰 미확인 사항부터, 실제 값이나 예시를 넣어 구체적으로, 한 번에 하나씩/);
  assert.doesNotMatch(w, /사소하고 구체적인 것부터/);
  const u = read('USAGE.md');
  assert.match(u, /서버 실행을 자동화하지 않습니다/);
  assert.doesNotMatch(u, /서버를 대신 띄우거나/);
  assert.match(read('PLAYBOOK.md'), /초안만 받고 내 터미널에서 실행\. 막히면 건너뛴다/);
});

test('평가 자료 보완: 증거 위치 열, 의도 갱신 표, 입출력·예외 점검, 비공식 채점 안내를 담는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('templates/VERIFY.md'), /\| 요구·주장 \| 출처 \| 구현·계산 위치 \| 실행 전 기대 \| 검증 결과 \| 상태 \|/);
  assert.match(read('templates/WORK.md'), /## 의도 갱신/);
  assert.match(read('skills/verify-evidence/SKILL.md'), /구현·계산 위치: 파일·함수·커밋/);
  assert.match(read('skills/handoff-explain/SKILL.md'), /입력·출력·예외와 어떤 입력에서 깨지는지/);
  const u = read('USAGE.md');
  assert.match(u, /## 4\. 평가 자료가 되는 것들/);
  assert.match(u, /\*\*비공식 정보\*\*/);
  assert.match(u, /\*\*목표\*\*: R03/);
  assert.match(u, /Push는 하지 않습니다/);
  assert.equal(read('instructions/AGENTS.md'), read('instructions/working-rules.md'));
});

test('PROMPTS·checklists: 참조 경로가 실재하고, 커밋은 초안만 시키며, 사람용 문서를 지침이 참조하지 않는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const prompts = read('PROMPTS.md');
  for (const m of prompts.matchAll(/kit\/((?:skills|instructions|tools)\/[A-Za-z0-9_./-]*?\.(?:md|mjs|sh))/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), `PROMPTS.md 참조 경로 없음: ${m[1]}`);
  }
  assert.match(prompts, /Codex가 실행한 `git add`는 막힐 수 있으니 막히면 건너뜁니다/);
  assert.match(prompts, /git add \/ git commit 명령 초안만 알려줘\. 실행하지 마\./);
  assert.match(prompts, /`git add -A`는 쓰지 않습니다\. Push는 하지 않습니다\./);
  assert.match(read('PLAYBOOK.md'), /결론 1문장 → 근거\(이유·대안, 수치·파일 이름\) → 검증\(어떻게 확인했나\) → 한계/);
  assert.match(prompts, /구현 방법은 묻지 마/);
  for (const f of ['checklists/start-and-progress.md', 'checklists/before-submit.md', 'checklists/rules-and-security.md']) {
    const t = read(f);
    assert.match(t, /에이전트는 읽지 않습니다/, f);
    assert.ok(t.includes('- [ ]'), f);
    assert.doesNotMatch(t, /https?:\/\//, `${f}: 외부 주소 없음`);
  }
  assert.match(read('checklists/rules-and-security.md'), /Push를 하지 않았다/);
  const agents = read('instructions/AGENTS.md');
  assert.doesNotMatch(agents, /PROMPTS|checklists|USAGE|PLAYBOOK/, '사람용 문서는 지침에서 참조하지 않는다');
  assert.match(read('skills/handoff-explain/SKILL.md'), /에이전트 제안 중 내가 고치거나 쓰지 않은 부분/);
  assert.match(read('README.md'), /\| `PROMPTS\.md` \|/);
  assert.match(read('README.md'), /\| `checklists\/` \|/);
});

test('근거표·데이터 과제 체크리스트: 5열 표와 상태 4종, 별도 문서 금지 안내, 데이터 점검 항목과 profile-csv 연결', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const v = read('templates/VERIFY.md');
  assert.match(v, /별도 문서를 늘리지 않는다/);
  assert.match(v, /\*\*확인함\*\*.*\*\*미검증\*\*.*\*\*실패\*\*.*\*\*미확인\*\*/);
  const ev = read('skills/verify-evidence/SKILL.md');
  assert.match(ev, /출처: 과제 안내·문서의 위치나 담당자 답변 번호/);
  assert.match(ev, /상태: 확인함 \/ 미검증\(이유와 함께\) \/ 실패\(현상과 남은 문제\) \/ 미확인\(자료·답이 없음\)/);
  assert.match(ev, /별도 문서를 늘리지 않는다/);
  const d = read('checklists/data-tasks.md');
  for (const k of ['데이터를 다루는 과제일 때만', '조인 전후 행 수', '몰려 있는지', '분자·분모·단위·기간·집계 단위·필터', '제외 사유별 건수', '다른 방법', '사실·계산·가설·미확인', 'profile-csv.mjs', '관찰만']) assert.ok(d.includes(k), `data-tasks.md: ${k}`);
  assert.doesNotMatch(d, /https?:\/\//);
  assert.doesNotMatch(read('instructions/AGENTS.md'), /data-tasks/, '사람용 문서는 지침이 참조하지 않는다');
  assert.match(read('README.md'), /`data-tasks\.md`/);
});

test('최종 문구: 배치 동작은 요구에 있을 때만, 개인정보는 요구 없는 노출만 금지, 커밋은 허용된 방식으로만, 서술형 출제는 단정하지 않는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('PROMPTS.md'), /아래 동작은 과제 요구나 담당자 확인에 포함된 경우에만 적용해줘\./);
  assert.match(read('checklists/before-submit.md'), /요구에 없는 개인정보·사번이 노출되지 않았고, 비밀값이 없다/);
  assert.doesNotMatch(read('checklists/before-submit.md'), /개인정보·사번·비밀값이 결과물과 문서에 없다/);
  assert.match(read('checklists/rules-and-security.md'), /로컬 커밋은 제공 환경에서 허용된 방식으로만 했고, 차단되면 생략했다/);
  assert.doesNotMatch(read('checklists/rules-and-security.md'), /내 터미널에서 직접 했다/);
  const u = read('USAGE.md');
  assert.match(read('PLAYBOOK.md'), /제출물과 수행 과정을 설명할 수 있도록 준비한다/);
  assert.doesNotMatch(u, /서술형은 제출물과 작업 기록에서 문항이 나옵니다/);
  assert.match(u, /로컬 커밋은 제공 환경에서 허용된 방식으로만 하고, 차단되면 우회하지 말고 생략합니다/);
  assert.doesNotMatch(u, /개인정보·비밀값이 결과물에 없다/);
});

test('verify-evidence: 화면은 응시자가 직접 확인하고, 브라우저 자동화는 허용될 때만 임시 환경에서 쓰며 미리보기 확인과 구분한다', () => {
  const v = fs.readFileSync(path.join(ROOT, 'skills/verify-evidence/SKILL.md'), 'utf8');
  assert.match(v, /응시자가 제공된 미리보기에서 직접/);
  assert.match(v, /과제 안내가 허용하면 브라우저 자동화\(Playwright 등\)를 별도 포트·임시 DB·합성 데이터로 실행할 수 있고/);
  assert.match(v, /설치나 실행이 막히면 우회하지 않는다/);
  assert.match(v, /"자동화 확인"으로 적고 실제 미리보기 확인/);
  assert.doesNotMatch(v, /직접 열어 .*눈으로 확인한다/);
  const h = fs.readFileSync(path.join(ROOT, 'skills/handoff-explain/SKILL.md'), 'utf8');
  assert.match(h, /과제 풀이 단계에서만/);
});

test('profile-csv: 닫히지 않은·비정상 따옴표는 경고하고, 물리적 시작 줄을 알린다', () => {
  const open = parseCsvDetailed('id,name\n1,"unfinished\n2,next\n');
  assert.ok(open.warnings.some((w) => w.includes('닫히지 않아')), open.warnings.join('|'));
  const mid = parseCsvDetailed('id,name\n1,ab"c\n');
  assert.equal(mid.rows[1][1], 'ab"c', '값 중간 따옴표는 글자 그대로 둔다');
  assert.ok(mid.warnings.length >= 1);
  const after = parseCsvDetailed('id,name\n1,"ab"c\n');
  assert.ok(after.warnings.some((w) => w.includes('닫는 따옴표 뒤')));
  assert.deepEqual(parseCsvDetailed('a,b\n1,"x,y"\n2,"l1\nl2"\n').warnings, [], '정상 CSV는 경고 없음');
  const p = profile('id,name\n1,"a\nb"\n2,x,y\n');
  assert.equal(p.widthMismatch[0].line, 4, '필드 안 줄바꿈이 있어도 실제 줄 번호');
  assert.equal(p.widthMismatch[0].record, 3);
});

test('보완 5가지가 지침·스킬·템플릿에 반영되어 있다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const a = read('instructions/AGENTS.md');
  // 1. 요청에 없는 되돌리기 어려운 행동은 확인, 요청 범위 안은 다시 묻지 않음, 막힌 것은 우회하지 않음
  assert.match(a, /되돌리기 어려운 행동은 실행 전에 확인한다/);
  assert.match(a, /요청 범위에 이미 포함된 행동은 다시 묻지 않는다/);
  assert.match(a, /우회하지 않고/);
  // 5. 맥락 압축·재개 시 상태 문서, 작은 진척마다 쓰지 않음
  assert.match(a, /맥락이 압축/);
  assert.match(a, /작은 진척마다 쓰지 않는다/);
  // 2. 재시도 전 이유 설명
  assert.match(read('skills/debug-rootcause/SKILL.md'), /앞선 시도와 무엇이 다르고/);
  // 3. 핵심 가정 우선 확인
  assert.match(read('skills/work-intake/SKILL.md'), /\*\*핵심 가정\*\*/);
  assert.match(read('skills/work-intake/SKILL.md'), /먼저 검증한다/);
  // 4. 목표 달성 구분 + 자체 점검 표기
  assert.match(read('skills/verify-evidence/SKILL.md'), /목표를 달성한 것도 다르므로/);
  assert.match(read('skills/verify-evidence/SKILL.md'), /자체 점검\(독립 검토 아님\)/);
  // 5. WORK.md 갱신 기준
  assert.match(read('templates/WORK.md'), /그대로 두면 다음 판단이나 행동을 잘못하게 될 때만/);
  // 과잉 확인 방지: 모든 행동을 묻게 하는 문구가 아니어야 함
  assert.doesNotMatch(a, /모든 (행동|작업)(은|을) .*확인한다/);
  assert.ok(Buffer.byteLength(a) < 4300, `AGENTS.md ${Buffer.byteLength(a)}B`);
});

// ───────── v2: 재시험(웹 + 기존 개선) 보완 ─────────
test('v2 지침: 기준선, 실제 파일, 브라우저 자동화 조건, 병렬 세션 규칙이 AGENTS.md에 있고 improve-existing을 참조한다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const a = read('instructions/AGENTS.md');
  assert.match(a, /개선 과제면 기존 수치와 계산식, 곧 기준선 포함/);
  assert.match(a, /심볼릭 링크·이동 금지/);
  assert.match(a, /허용된 브라우저 자동화\(별도 포트·임시 DB\)/);
  assert.match(a, /세션 여럿이면 `WORK\.md`의 담당 파일 밖은 고치지 않고/);
  assert.match(a, /`kit\/skills\/improve-existing\/SKILL\.md`/);
  assert.doesNotMatch(a, /PROMPTS|checklists|USAGE|PLAYBOOK/, '사람용 문서는 지침에서 참조하지 않는다');
  assert.equal(a, read('instructions/working-rules.md'));
});

test('improve-existing: 기준선 → 격리 실험 → 같은 조건의 전후 비교 절차를 담는다', () => {
  const t = fs.readFileSync(path.join(ROOT, 'skills/improve-existing/SKILL.md'), 'utf8');
  for (const k of ['기준선', '규모 점검', '스냅샷', '한 번에 하나', '시간 상한', '복사본이나 버전 플래그', '나빠진 지표', '기준선 없이 개선 주장하기']) assert.ok(t.includes(k), `improve-existing: ${k}`);
  assert.doesNotMatch(t, /https?:\/\//);
});

test('v2 스킬·템플릿: 질문 분류, 처음부터의 화면 상태, 로그인 스모크, 모의 구술, 기준선·계약·담당 파일 절', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /업무 사실은 담당자, 과제 문구의 뜻은 출제 안내 채널, 설계 선택은 응시자가 정하고\(에이전트는 선택지와 추천을 낸다\)/);
  assert.match(w, /담당자가 모른다고 한 것은 다시 묻지 않고/);
  assert.match(w, /improve-existing/);
  const u = read('skills/web-ui-basics/SKILL.md');
  assert.match(u, /처음 구현부터 빠짐없이/);
  assert.match(u, /세션 쿠키\(SameSite 등\)와 CSRF/);
  const h = read('skills/handoff-explain/SKILL.md');
  assert.match(h, /모의 구술/);
  assert.match(h, /설명할 수 있는 범위를 넘는 산출물/);
  assert.match(read('templates/TASK.md'), /## 기준선/);
  assert.match(read('templates/TASK.md'), /\| # \| 분류 \|/);
  const wk = read('templates/WORK.md');
  for (const k of ['## 계약', '## 담당 파일·세션', '## 실험 (개선·탐색 과제일 때)']) assert.ok(wk.includes(k), `WORK.md: ${k}`);
  assert.match(read('templates/VERIFY.md'), /자동화 확인/);
});

test('v3 PLAYBOOK: 6단계 체크리스트(할 일·끝 신호·설명 노트), 세션 2개, 합류 2번, v2 구조가 남지 않는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const heads = ['## 한 장 요약', '## 0. 시작', '## ① 읽기·인터뷰', '## ② 기준선·계약', '## ③ 첫 연결', '### 합류 1 (75분)', '## ④ 실험·완성 (75–145분) — 이 시험의 중심', '### 합류 2 = 동결 (145분)', '## ⑤ 검증', '## ⑥ 문서·서술형 준비', '## 서술형', '## 부록 A. 막혔을 때', '## 부록 B.', '## 부록 C.', '## 부록 D. 추론 강도', '## 부록 E.'];
  let at = -1;
  for (const h of heads) { const i = pb.indexOf(h); assert.ok(i > at, `PLAYBOOK 순서·존재: ${h}`); at = i; }
  // 단계마다 할 일(☐)과 끝 신호(✔), ①~⑤에는 설명 노트(✎)
  for (const [n, next] of [['①', '②'], ['②', '③'], ['③', '④'], ['④', '⑤'], ['⑤', '⑥'], ['⑥', '서술형']]) {
    const sec = pb.slice(pb.indexOf(`## ${n} `), pb.indexOf(`## ${next}`));
    assert.ok(sec.includes('☐') && sec.includes('✔'), `${n}: 할 일·끝 신호`);
    if (n !== '⑥') assert.ok(sec.includes('✎ 설명 노트'), `${n}: 설명 노트`);
  }
  assert.match(pb, /\| \*\*메인\*\* \|/);
  assert.match(pb, /\| \*\*화면\*\* \|/);
  for (const k of ['마지막 실험은 **110분까지** 시작한다', '55분까지 계약이 안 끝나면', '프론트/백엔드로 나누지 않습니다', '심볼릭 링크', '제출 가능한 상태', '`0.0.0.0`', '화면 세션은 **닫지 않고**', '복사본이나 버전 플래그에서만', '시험 중에는 **이 문서만** 봅니다']) assert.ok(pb.includes(k), `PLAYBOOK.md: ${k}`);
  assert.doesNotMatch(pb, /\bT[1-4]\b|M·A·B|R 세션|3-g|\b[0-9]-[a-k]\b/, 'v2 구조(세션 4종, T1~T4, 옛 번호)가 남음');
  assert.ok(pb.trimEnd().split('\n').length <= 240, `PLAYBOOK 길이 ${pb.trimEnd().split('\n').length}줄`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'PRETEST.md')), 'PRETEST.md는 지웠다(사전 체험 완료)');
  // 체크리스트·README·USAGE
  assert.match(read('checklists/rules-and-security.md'), /브라우저 자동화\(Playwright 등\)는 과제 안내가 허용한 것을 확인한 뒤에만/);
  assert.match(read('checklists/before-submit.md'), /심볼릭 링크가 아닌 실제 파일/);
  assert.match(read('checklists/start-and-progress.md'), /기준선/);
  assert.match(read('README.md'), /`skills\/improve-existing`/);
  assert.match(read('README.md'), /\*\*시험 중에는 이것만 본다\*\*/);
  assert.match(read('USAGE.md'), /`skills\/improve-existing`/);
  const u = read('USAGE.md');
  for (const k of ['시간 배분', '## 1. 공통 시작 절차', '## 4. 막혔을 때', '## 5. 체크리스트', '사전 체험(15분)에서 확인할 것']) assert.ok(!u.includes(k), `USAGE.md에 남은 중복: ${k}`);
  for (const f of ['README.md', 'USAGE.md', 'checklists/start-and-progress.md', 'templates/TASK.md', 'templates/WORK.md']) assert.doesNotMatch(read(f), /M·A·B|\bR 세션|3-g|\b[0-9]-[a-k]\b/, `${f}: 옛 번호·세션 이름`);
});

test('v3 프롬프트 번호: PLAYBOOK과 PROMPTS가 같은 번호를 쓰고, 모든 프롬프트에 강도가 있으며 값이 같다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const LEVEL = 'low~medium|extra-high|more-reasoning|medium|high|low';
  const pr = read('PROMPTS.md');
  const pb = read('PLAYBOOK.md');
  const ID = String.raw`(?:\d-\d|막힘-\d+|유형-\d|보조-\d)`;
  const NO_LEVEL = new Set(['막힘-8', '유형-4']); // 질문 틀, 터미널 명령
  const tags = new Map();
  for (const ln of pr.split('\n')) {
    const m = ln.match(new RegExp(`^\\*\\*(${ID})\\.`));
    if (!m) continue;
    assert.ok(!tags.has(m[1]), `PROMPTS.md 번호 중복: ${m[1]}`);
    const tg = ln.match(new RegExp(`· 강도 \`(${LEVEL})\``));
    if (NO_LEVEL.has(m[1])) { tags.set(m[1], null); continue; }
    assert.ok(tg, `PROMPTS.md: 강도 없음 ${m[1]}`);
    tags.set(m[1], tg[1]);
  }
  assert.ok(tags.size >= 40, `프롬프트 수 ${tags.size}`);
  // PLAYBOOK이 가리키는 번호는 PROMPTS에 있고, PROMPTS의 번호는 모두 PLAYBOOK에서 가리킨다(PLAYBOOK이 전체 색인)
  const refs = new Set([...pb.matchAll(new RegExp(`(?<![\\w-])(${ID})(?![\\d])`, 'g'))].map((m) => m[1]));
  for (const id of refs) assert.ok(tags.has(id), `PROMPTS.md에 ${id} 없음`);
  for (const id of tags.keys()) assert.ok(refs.has(id), `PLAYBOOK.md가 ${id}를 가리키지 않음`);
  // PLAYBOOK의 "번호(강도)"가 PROMPTS 제목의 강도와 같다
  const inline = [...pb.matchAll(new RegExp(`(${ID})\\((${LEVEL})\\)`, 'g'))];
  assert.ok(inline.length >= 35, `본문 표시 수 ${inline.length}`);
  for (const [, id, lv] of inline) assert.equal(lv, tags.get(id), `PLAYBOOK ${id}(${lv}) ≠ PROMPTS ${tags.get(id)}`);
  // [화면] 표시는 화면 세션 프롬프트에만
  for (const id of ['3-2', '3-4', '4-1', '4-6', '4-7']) assert.match(pr, new RegExp(`\\*\\*${id}\\. \\[화면\\]`), `${id}: [화면] 표시`);
  assert.match(pr, /\*\*보조-1\. \[보조\]/);
  // 참조 경로 실재
  for (const m of pr.matchAll(/kit\/((?:skills|instructions|tools)\/[A-Za-z0-9_./-]*?\.(?:md|mjs|sh))/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `참조 경로 없음: ${m[1]}`);
  assert.doesNotMatch(read('instructions/AGENTS.md'), /강도|extra-high|PROMPTS|PLAYBOOK/, '지침은 늘리지 않고 사람용 문서를 참조하지 않는다');
});

test('v3 빈칸: 중괄호가 있는 프롬프트에는 "채우기" 줄이 있고, 파일 목록·포트·DB는 담당 파일 표를 읽게 한다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pr = read('PROMPTS.md');
  const blocks = pr.split(/\n(?=\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\.)/).slice(1);
  let withBraces = 0;
  for (const b of blocks) {
    const id = b.match(/^\*\*([^.]+)\./)[1];
    const body = b.split(/\n(?=---|## )/)[0];
    const code = [...body.matchAll(/```(?:text|bash)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    if (/\{[^}]+\}/.test(code)) { withBraces++; assert.match(body, /채우기:/, `${id}: 채우기 줄 없음`); }
    assert.doesNotMatch(code, /\{(엔진 파일 목록|서비스·화면 파일 목록|임시 경로)\}|(?<!Q)\{번호\}/, `${id}: 파일 목록·포트·DB를 중괄호로 묻는다`);
  }
  assert.ok(withBraces <= 16, `중괄호가 있는 프롬프트 ${withBraces}개 (늘리지 않는다)`);
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  assert.match(sec('2-2'), /"담당 파일·세션" 표를 두 행으로/);
  assert.match(sec('3-2'), /"담당 파일·세션" 표의 화면 행/);
  assert.match(sec('막힘-5'), /이 세션은 \{메인\|화면\} 세션이야\. 수정해도 되는 파일은 WORK\.md "담당 파일·세션" 표/);
  const wk = read('templates/WORK.md');
  assert.match(wk, /\| 메인 \| 엔진·개선·문서·통합 \| \| \|/);
  assert.match(wk, /\| 화면 \| 서비스 API·화면\(자동 점검을 쓰면 `e2e\/` 포함\) \| \| \|/);
  assert.doesNotMatch(wk, /## 제안/);
});

test('v3 서술형 대비: 파일을 볼 수 없다는 전제로 설명 노트·외울 5줄·답안 구조·7영역 연습·리허설을 둔다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const wk = read('templates/WORK.md');
  assert.match(wk, /## 설명 노트 \(서술형 대비, 응시자가 내 말로 쓴다\)/);
  for (const k of ['문제와 범위', '구조', '알고리즘', '데이터', '권한', '실패 대응', '검증·한계', 'AI 협업']) assert.match(wk, new RegExp(`\\| ${k} \\| \\| \\|`), `WORK.md 설명 노트: ${k}`);
  assert.match(wk, /외울 5줄/);
  const pb = read('PLAYBOOK.md');
  for (const k of ['내 파일은 볼 수 없다고 가정한다', '**외울 5줄**', '**준비 10분 쓰는 법**', '**답안 구조 (문항당 5분)**', '**7영역 연습 질문**', '하지 않은 일을 한 것처럼 쓰지 않는다', '제출물과 수행 과정을 설명할 수 있도록 준비한다']) assert.ok(pb.includes(k), `PLAYBOOK.md: ${k}`);
  const practice = pb.slice(pb.indexOf('**7영역 연습 질문**'), pb.indexOf('## 부록 A'));
  assert.equal(practice.split('\n').filter((l) => /^\| (구조|알고리즘|데이터|권한|실패 대응|검증·한계|AI 협업) \|/.test(l)).length, 7);
  assert.doesNotMatch(pb, /6영역/);
  const pr = read('PROMPTS.md');
  assert.match(pr, /\*\*6-2\. 기록과 최종 코드 대조, 외울 5줄\*\*/);
  assert.match(pr, /\*\*6-3\. 모의 구술\*\*/);
  assert.match(pr, /내가 먼저 답할 테니 답하기 전에는 정답을 알려주지 마/);
  assert.match(pr, /후보는 그대로 쓰지 말고 \*\*내 말로 고쳐\*\*/);
  assert.match(read('PLAYBOOK.md'), /시험 전에 연습 과제로 이 문서를 처음부터 끝까지 한 번 따라가 봅니다/);
  const h = read('skills/handoff-explain/SKILL.md');
  assert.match(h, /설명 노트는 응시자가 쓴 것이므로 고쳐 쓰지 않고/);
  assert.ok(h.length < 2500, `handoff-explain ${h.length}`);
});

test('인터뷰 절차: 질문 하나씩 복붙, 영향 큰 순서, 꼬리질문 상한, 모른다→미확인, 직접 결정→설계 선택, 미확인 정리, 합의 확인', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /아래 다섯 가지로 나눠/);
  assert.match(w, /한 번에 질문 하나로 진행한다/);
  assert.match(w, /`Q3-1`, `Q3-2`\(한 질문에 최대 2회\)/);
  assert.match(w, /모르겠다·기준 없음: 상태 미확인/);
  assert.match(w, /직접 결정해라: 선택지 2개와 추천을 보여 주고/);
  assert.match(w, /영향도\(핵심\/일반\)와 코드 표시 위치/);
  assert.match(w, /`확인 전 가정\(Q번호\)` 주석/);
  assert.match(w, /기록만 근거로/);
  assert.match(w, /설계 선택은 "이렇게 하겠다"로 알린다/);
  const t = read('templates/TASK.md');
  assert.match(t, /\| # \| 분류 \| 질문\(보낸 문장\) \| 답변\(원문 요지\) \| 상태 \| 반영 \|/);
  assert.match(t, /\| # \| 항목 \| 고려한 선택지 \| 선택 \| 정한 사람 \| 이유 \| 판별 사례\(입력 → 기대 결과\) \| 영향\(의존하는 코드·문서\) \| 발생 질문 \|/);
  assert.match(t, /\| # \| 가정 \| 근거 질문 \| 영향도 \| 코드 표시 위치 \| 상태 \|/);
  for (const s of ['확정', '추가질문', '미확인', '설계 선택']) assert.ok(t.includes(s), `TASK.md 상태: ${s}`);
  const pr = read('PROMPTS.md');
  for (const k of ['**1-2. 인터뷰 시작', '**1-3. 답변 전달', '**1-4.', '**1-5. 미확인 정리', '**1-6. 합의 확인 글']) assert.ok(pr.includes(k), `PROMPTS.md: ${k}`);
  assert.match(pr, /처음 1~2개는 답하기 쉬운 맥락 질문\(누가, 어떤 상황에서, 무엇을 결정하려고 쓰나\)으로 열고, 그다음은 결과에 미치는 영향이 큰 순서로/);
  assert.doesNotMatch(pr + read('PLAYBOOK.md'), /최대 6개|본질문 최대/, '질문 개수 상한은 두지 않는다');
  assert.doesNotMatch(pr + read('PLAYBOOK.md'), /20분이 (되면|넘었을)|아직 묻지 않은 질문은 묻지 말고/, '인터뷰 시간 상한은 두지 않는다');
  assert.match(pr, /구현 방법은 묻지 마/);
  assert.doesNotMatch(w, /https?:\/\//);
});

test('세션 끊김 대비: 막힘-5 복구 프롬프트, 막혔을 때 행, 실험은 시작할 때 기록', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const pr = read('PROMPTS.md');
  assert.match(pb, /\| 세션이 끊김 \|.*`codex resume`.*막힘-5/);
  assert.match(pb, /가설·변경 계획·조건\(입력·시드·시간 제한\)을 카드에 \*\*먼저\*\* 적고\(끊겨도 남게\)/);
  assert.match(pr, /\*\*막힘-5\. 세션이 끊겨 새로 시작했을 때/);
  assert.match(pr, /이전 대화는 없다고 가정하고 파일 기록만으로 상태를 복구해줘\. 코드는 아직 고치지 마\./);
  assert.match(pr, /AGENTS\.md, TASK\.md, WORK\.md, VERIFY\.md, EXPERIMENTS\.md 를 읽고/);
});

test('응시 환경 안내 반영: PRETEST.md 삭제, 참조 없음, 확인된 사실(탭 8개·RAM 16GB, 제출 자동 제외, 공개 저장소 clone, MCP, 외부 AI API 금지)', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.ok(!fs.existsSync(path.join(ROOT, 'PRETEST.md')));
  for (const f of ['README.md', 'USAGE.md', 'PLAYBOOK.md', 'PROMPTS.md', 'mcp/README.md', 'instructions/AGENTS.md', 'checklists/start-and-progress.md', 'checklists/before-submit.md', 'checklists/rules-and-security.md']) assert.doesNotMatch(read(f), /PRETEST|사전 체험(\(15분\))?에서/, `${f}: PRETEST 참조가 남음`);
  const pb = read('PLAYBOOK.md');
  assert.match(pb, /터미널 탭은 최대 8개, 작업 환경 RAM은 16GB/);
  assert.match(pb, /제출 수집에서 심볼릭 링크와 `\.git`·`node_modules`·빌드·캐시 폴더는 자동 제외된다/);
  assert.match(pb, /완료 화면의 "제출 파일 N개 · 크기"로 실제 제출 확인/);
  assert.match(read('README.md'), /`git clone`으로 가져오는 것은 허용되고, 개인 PC 파일 업로드는 막혀 있습니다/);
  assert.match(read('README.md'), /`\.agents\/skills` 경로에 쓸 수 있는지는 확인되지 않았습니다/);
  const mcp = read('mcp/README.md');
  assert.match(mcp, /MCP 사용은 허용됩니다/);
  assert.match(mcp, /Codex를 정상 종료\(`\/quit` 또는 `\/exit`\)하고 다시 `codex`로 실행해야 적용됩니다/);
  assert.match(mcp, /별도 AI 모델 연결과 시험 자료·작업물의 외부 반출 용도로는 쓸 수 없습니다/);
  assert.match(read('instructions/AGENTS.md'), /결과물에서 외부 AI API·AI 모델을 쓰지 않는다/);
  assert.doesNotMatch(read('instructions/AGENTS.md') + read('README.md') + pb, /마크다운 미리보기|옆에 미리보기 열기/);
});

test('시나리오·비기능 요구: TASK.md 두 절(근거 필수 열, 확인 방법 열), 지어내지 않는 문구, 인터뷰·합의 확인·자동 점검과 연결', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const t = read('templates/TASK.md');
  assert.match(t, /## 사용자·시나리오 \(웹·서비스 과제일 때만, 근거 있는 것만\)/);
  assert.match(t, /\| # \| 누가 \| 하려는 일 \| 근거\(출처·Q번호\) \| 확인 방법 \|/);
  assert.match(t, /## 비기능 요구 \(웹·서비스 과제일 때만, 근거 있는 것만\)/);
  assert.match(t, /\| # \| 항목 \| 기준 \| 근거\(출처·Q번호\) \| 확인 방법 \|/);
  assert.match(t, /지어내지 않는다/);
  assert.match(t, /- 사용자·시나리오와 비기능 요구 \(웹·서비스 과제일 때, 위 표의 것만\):/);
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /웹·서비스 과제면 시나리오·비기능 요구도/);
  assert.ok(w.length < 2500, `work-intake ${w.length}`);
  const pr = read('PROMPTS.md');
  assert.match(pr, /사용자·시나리오\(S번호\)와 비기능 요구\(N번호\)도 근거가 있는 것만 기록해줘/);
  assert.match(pr, /사용자·시나리오와 비기능 요구\(TASK\.md 에 있는 것만\)/);
  assert.match(pr, /시나리오 번호\(S1, S2…\)별로 묶어/);
  assert.match(read('PLAYBOOK.md'), /사용자·시나리오\(`S#`\)와 비기능 요구\(`N#`\)도 \*\*근거 있는 것만\*\* `TASK\.md`에/);
  assert.doesNotMatch(read('instructions/AGENTS.md'), /시나리오|비기능/, 'AGENTS.md 용량을 늘리지 않는다');
});

test('추론 강도: PLAYBOOK 부록 D(제안, 응답 시간을 보고 조정, 기본 medium, 1-3은 내리지 않음), PROMPTS 안내, 계약은 extra-high', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const d = pb.slice(pb.indexOf('## 부록 D. 추론 강도'), pb.indexOf('## 부록 E'));
  assert.match(d, /처음 몇 번의 응답 시간을 보고 조정한다/);
  assert.match(d, /기본은 medium/);
  assert.match(d, /인터뷰 답변 전달\(1-3\)은 medium보다 내리지 않는다/);
  assert.match(d, /한 단계 올려 다시 요청/);
  assert.match(pb, /번호 뒤 괄호는 추천 추론 강도입니다\(부록 D\)/);
  assert.match(read('PROMPTS.md'), /제목 끝의 `강도`는 추천 추론 강도입니다/);
  assert.match(read('PROMPTS.md'), /\*\*2-2\. 계약과 담당 파일 표\*\* · 강도 `extra-high`/);
});

test('설계 보강 7가지: 판별 사례, 대표 입력 흐름, AI 협업·사람 개입, 숨은 선택·정한 사람, 다음 할 일 한 줄, 실행 전 기대, 설명 순서', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pr = read('PROMPTS.md');
  const pb = read('PLAYBOOK.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  // 1) 판별 사례: 설계 선택 표·인터뷰 스킬·직접 정하라·개선 채택·검증에서 이어진다
  assert.match(read('templates/TASK.md'), /판별 사례는 선택지마다 결과가 달라지는 작은 입력과 손으로 계산한 기대 결과다/);
  assert.match(read('skills/work-intake/SKILL.md'), /선택지마다 결과가 달라지는 작은 입력과 기대 결과\(판별 사례\)를 붙인다/);
  assert.match(sec('1-4'), /판별 사례/);
  assert.match(sec('4-5'), /판별 사례를 테스트로 남기고/);
  assert.match(sec('5-2'), /판별 사례가 테스트로 실행되는지/);
  assert.match(pb, /결과가 달라지는 선택이면 \*\*판별 사례\*\*까지/);
  // 2) 대표 입력 흐름: 6-2와 외울 5줄
  assert.match(sec('3-5'), /대표 입력 하나를 골라 실제 값으로 입력 → 진입점\(파일:함수\) → 처리 → 저장 → 출력/);
  assert.match(sec('3-5'), /"\(코드 읽기 기준\)"/);
  assert.match(pb, /2\. 대표 입력 한 개의 흐름/);
  assert.match(read('templates/WORK.md'), /②대표 입력 한 개의 흐름/);
  // 3) AI 협업·사람 개입 표
  const wk = read('templates/WORK.md');
  assert.match(wk, /## 사람 개입 \(AI 제안에 내가 판단을 더한 것\)/);
  assert.match(wk, /\| 시점 \| AI 제안 요지 \| 내 판단\(비교 후 채택\/근거 확인 후 채택\/수정\/거절\/검증 방법 지적\) \| 바꾼 내용 \| 이유 \|/);
  assert.match(sec('6-3'), /AI 협업 일곱 영역/);
  assert.match(pb, /AI 제안을 비교해 고르거나, 고치거나, 거절했으면 `WORK\.md` \*\*사람 개입\*\* 표에도 한 줄/);
  assert.match(read('skills/handoff-explain/SKILL.md'), /AI 협업 일곱 영역마다/);
  // 4) 숨은 선택과 정한 사람
  assert.match(sec('4-5'), /숨은 선택: 이번 변경으로 생기거나 바뀌는 선택\(가중치, 동점 처리, 기본값, 정렬 기준, 근사, 예외 무시\) 중 TASK\.md 설계 선택 표에 없는 것/);
  assert.match(sec('4-5'), /정한 사람: 각 선택이 내가 고른 것인지, 아직 AI 가정인지\(기록이 없으면 "미기록"\)/);
  assert.match(sec('4-2'), /정한 사람이 비었거나 "AI 가정"인 항목/);
  // 5) 보고 끝에 다음 할 일 (지침 용량 한도 안에서)
  const ag = read('instructions/AGENTS.md');
  assert.match(ag, /끝에 사용자가 다음에 할 일을 한 줄로 적는다/);
  assert.equal(ag, read('instructions/working-rules.md'));
  assert.ok(Buffer.byteLength(ag) <= 4300, `AGENTS.md ${Buffer.byteLength(ag)}B`);
  // 6) 실행 전 기대
  assert.match(read('templates/VERIFY.md'), /실행 전 기대: 실행하기 \*\*전에\*\* 적은 기대 결과/);
  assert.match(read('skills/verify-evidence/SKILL.md'), /실행 전 기대: 2번에서 정한 기대 결과\. 실행 전에 적고, 결과에 맞춰 바꾸지 않는다\. 손계산이 틀렸으면 원래 값을 남기고 고친 값과 이유를 덧붙인다/);
  assert.match(read('README.md'), /실행 전 기대 \/ 검증 결과/);
  assert.match(pb, /\*\*실행 전 기대를 먼저 적고\*\*/);
  // 7) 설명 순서
  assert.match(pb, /\*\*설명 순서 팁\*\*: 웹 과제의 동작은 "화면에서 한 행동 → 바로 바뀐 것 → 그렇게 된 이유 → 코드 흐름 한 줄", 한계는 "약점 → 그 영향 → 다음에 확인·개선할 방법"/);
  for (const f of ['skills/work-intake/SKILL.md', 'skills/verify-evidence/SKILL.md', 'skills/handoff-explain/SKILL.md']) assert.ok(read(f).length < 2500, f);
});

test('운영 보강: 첫 실제 연결 75분, 승인 기준(규칙 변경은 승인·버그는 고친 뒤 보고), 설명 확인 분산, 화면 세션 유지, 읽기 전용 보조 세션, 질문 종료 기준', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const pr = read('PROMPTS.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  // 1) 첫 연결을 ③(45–75분)의 끝 신호로, 실제 연결 프롬프트는 ③에
  assert.match(pb, /\| ③ 첫 연결 \| 45–75분 \|.*가장 단순한 입력 하나가 \*\*실제 API를 거쳐 화면에 뜬다\*\*/);
  assert.match(pb, /✔ 가장 단순한 입력 하나가 실제 API를 거쳐 화면에 뜬다\./);
  assert.match(pb, /⏱ 85분까지 연결이 안 되면 개선을 미루고/);
  assert.ok(pr.indexOf('**3-4. [화면] 실제 연결') < pr.indexOf('## 4. '), '실제 연결은 3단계 프롬프트');
  // 2) 승인 기준
  assert.match(pb, /\*\*승인 기준\*\*: 계약·업무 규칙·지표·범위 변경과 알고리즘 채택은 내가 고른다\. 합의된 동작과 다르게 작동하는 버그, 계약을 지키는 내부 수정은 세션이 \*\*고친 뒤 회귀 테스트와 함께 보고\*\*한다/);
  for (const id of ['3-2', '4-6']) assert.match(sec(id), /버그(는|면)[^\n]*고치/, `${id}: 버그는 고친 뒤 보고`);
  assert.doesNotMatch(sec('4-6'), /바로 고치지 마/);
  assert.match(sec('4-2'), /버그 수정은 확인되면 그대로 두고 결과만 표로 알려줘/);
  assert.match(sec('4-7'), /같은 실패를 두 번 고쳤는데 그대로야/);
  // 3) 설명 확인 분산: 흐름은 합류 1(3-5), 숨은 선택은 채택 직전(4-5), 정한 사람은 합류(4-2), 6-2는 대조만
  assert.match(pb, /3-5\(medium\) 대표 입력 흐름/);
  assert.match(pb, /4-5\(high\) \*\*채택 전 점검\*\*/);
  assert.match(pb, /마지막에는 새로 이해하지 않고 \*\*이미 적어 둔 것이 최종 코드와 맞는지만\*\* 확인합니다/);
  assert.doesNotMatch(sec('6-2'), /숨은 선택|진입점\(파일:함수\)/, '6-2는 대조와 외울 5줄만');
  // 4) 화면 세션은 닫지 않고 동결 뒤 회귀 수정만
  assert.match(pb, /\| \*\*합류 2 = 동결\*\* \| 145분 \|.*새 기능 없이 \*\*회귀 수정만\*\*/);
  assert.doesNotMatch(pb, /\*\*화면 세션 닫기\*\*|마지막 보고 후 \*\*닫는다\*\*/);
  // 5) 읽기 전용 보조 세션: 정해진 용도, 파일 수정 금지
  assert.match(pb, /\| 보조\(읽기 전용, 선택\) \| 메인이 바쁠 때 원인 조사\(막힘-1·막힘-3\), 교차 점검\(5-3\), ⑥의 대조·모의 구술\(6-2·6-3\) \|/);
  assert.match(pb, /보조 세션은 필요할 때만 엽니다\. 터미널 탭은 최대 8개/);
  assert.match(sec('보조-1'), /파일을 만들거나 고치지 말고, 서버 실행·설치·무거운 테스트도 하지 마/);
  assert.match(sec('보조-1'), /채우기:/);
  // 6) 질문 종료 기준(개수·시간 상한 없이), 판별 사례는 결과를 바꾸는 선택에만
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /더 물을지는 남은 불확실성이 핵심 결과를 바꾸는지, 가정으로 진행해도 나중에 되돌릴 수 있는지로 정한다/);
  assert.doesNotMatch(w, /질문 시간은 상한/);
  assert.match(pb, /\*\*언제 그만 묻나\*\*: 남은 질문이 핵심 결과를 바꾸지 않거나, 가정으로 진행해도 나중에 되돌릴 수 있으면/);
  assert.match(read('templates/TASK.md'), /\*\*결과를 바꾸는 선택\*\*\(계산 규칙, 제약, 동점 처리, 우선순위\)에만 적고/);
  assert.match(read('templates/VERIFY.md'), /손계산이 틀렸으면 원래 값을 지우지 말고 고친 값과 이유를 덧붙인다/);
  assert.ok(pb.trimEnd().split('\n').length <= 240);
});

test('탐색·최적화: optimize-search 스킬(구조화 → 독립 검증기 → 기본안 → 방법 선택 → 시간 제한 개선 → 같은 조건 비교 → 찾은 최선의 해), 템플릿 두 절, 프롬프트 유형-6~8, 지침·PLAYBOOK 연결', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const sk = read('skills/optimize-search/SKILL.md');
  for (const k of ['결정 변수와 그 유형(이산/연속/혼합), 필수 제약, 선호 조건', '유효해를 못 찾았을 때와 해가 없을 때의 처리', '**독립 검증기를 먼저 만든다.**', '탐색기의 점수나 내부 상태를 쓰지 않는다', '빈 입력, 불가능한 조건, 경계값', '**기본안**', '완전탐색·백트래킹', '분기 한정', '탐욕', '지역탐색·다중 시작', '정수계획·제약계획', 'BFS·다익스트라·A*', '난수 시드를 기록한다', '작은 입력에서는 완전탐색 결과와 비교', '"찾은 최선의 해"']) assert.ok(sk.includes(k), `optimize-search: ${k}`);
  // 각 단계가 순서대로: 구조 → 검증기 → 기본안 → 방법 → 개선 → 비교 → 표현
  let at = -1;
  for (const k of ['탐색·최적화 문제 구조', '독립 검증기를 먼저', '**기본안**', '방법은 변수 유형·입력 규모', '개선 틀', '`EXPERIMENTS.md`에 적는다', '찾은 최선의 해']) { const i = sk.indexOf(k); assert.ok(i > at, `순서: ${k}`); at = i; }
  assert.match(sk, /담당자 답 없이 정하지 않고 미확인·설계 선택으로 둔다/);
  const t = read('templates/TASK.md');
  assert.match(t, /## 탐색·최적화 문제 구조 \(여러 선택지 중 제약을 만족하는 좋은 조합을 찾는 과제일 때만\)/);
  for (const k of ['결정 변수와 유형', '필수 제약', '선호 조건', '평가 목표', '입력 규모', '실행 제한', '유효해를 못 찾았을 때 / 해가 없을 때']) assert.ok(t.includes(`| ${k} |`), `TASK.md: ${k}`);
  const w = read('templates/WORK.md');
  assert.match(w, /가설과 실험 결과는 `EXPERIMENTS\.md`에 쓴다/);
  assert.match(read('templates/EXPERIMENTS.md'), /유효해 미발견\(시간 안에 못 찾음\) \/ 해 없음\(불가능을 증명한 경우만\)/);
  const pr = read('PROMPTS.md');
  for (const id of ['유형-6', '유형-7', '유형-8']) assert.match(pr, new RegExp(`\\*\\*${id}\\. 탐색·최적화`), id);
  assert.match(pr, /먼저 입력 규모와 제약 구조를 근거로 방법 후보 2개와 추천을 보여주고 멈춰/);
  assert.match(read('PLAYBOOK.md'), /탐색·최적화\(제약을 만족하는 좋은 조합·배정·경로 찾기\): ②에서 2-2 뒤 유형-6\(high\)/);
  assert.match(read('instructions/AGENTS.md'), /\| 탐색·최적화 \| `kit\/skills\/optimize-search\/SKILL\.md` \|/);
  assert.match(read('README.md'), /`skills\/optimize-search`/);
  assert.match(read('USAGE.md'), /`skills\/optimize-search`/);
});

test('사람용·에이전트용 문서 정합: 지정 제출 문서 대응, 승인 기준과 결정 주체, 결정 기록 위치 하나, 두 번 실패 시 멈춤, e2e 소유', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pr = read('PROMPTS.md');
  const pb = read('PLAYBOOK.md');
  const wk = read('templates/WORK.md');
  const ag = read('instructions/AGENTS.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  // 1) 과제가 제출 문서 이름을 정하면: 0-2로 대응을 알리고 WORK.md에 남겨 복구 때도 읽힌다
  assert.match(pb, /0-2\(low\)로 대응을 알린다/);
  assert.match(sec('0-2'), /\{대신할 템플릿\}이라고 하면 \{지정 문서\}를 뜻해/);
  assert.match(sec('0-2'), /WORK\.md 맨 위 "문서 대응" 줄/);
  assert.match(wk, /문서 대응\(과제가 제출 문서 이름을 정했을 때만\): `TASK\.md` → , `VERIFY\.md` → /);
  assert.match(ag, /과제가 요구하는 제출 문서가 있으면 그 이름·경로의 실제 파일에 쓰고/);
  // 2) 승인 기준과 결정 주체가 에이전트가 읽는 문서에도 있다
  assert.match(wk, /승인 기준: 계약·업무 규칙·지표·범위 변경과 알고리즘 채택은 응시자가 고른다\. 합의된 동작과 다르게 작동하는 버그와 계약을 지키는 내부 수정은 세션이 고친 뒤 회귀 테스트와 함께 보고한다\. 같은 실패가 두 번 고쳐지지 않으면 멈추고 보고한다/);
  assert.match(ag, /결과를 바꾸는 선택은 선택지와 추천을 내고 사용자가 고르게 하며, 이유와 대안을 `TASK\.md` 설계 선택 표에 기록한다/);
  for (const f of ['skills/work-intake/SKILL.md', 'templates/TASK.md']) assert.doesNotMatch(read(f), /내가 정한|내가 정하고/, `${f}: 에이전트가 "내가"를 자신으로 읽을 수 있음`);
  // 3) 결정 기록은 TASK.md 설계 선택 표 한 곳. WORK.md에는 채택 기록(무엇을·왜)만
  assert.doesNotMatch(wk, /## 결정과 이유/);
  assert.match(wk, /## 채택 기록 \(합류 때 반영한 변경\)\n결과를 바꾸는 선택은 여기가 아니라 `TASK\.md` 설계 선택 표에 쓴다/);
  assert.match(pb, /`WORK\.md` \*\*채택 기록\*\*에 한 줄/);
  assert.doesNotMatch(read('USAGE.md'), /`WORK\.md` 결정 표/);
  // 4) 화면 자동 점검은 두 번 실패하면 멈춘다(4-7과 같은 기준)
  assert.match(sec('4-6'), /같은 항목을 두 번 고쳐도 실패하면 더 고치지 말고 멈춰서 보고해줘/);
  // 5) e2e/ 는 화면 행에 들어간다
  assert.match(sec('2-2'), /화면 자동 점검을 쓰면 `e2e\/` 포함/);
  assert.ok(Buffer.byteLength(ag) < 4300, `AGENTS.md ${Buffer.byteLength(ag)}B`);
  assert.equal(ag, read('instructions/working-rules.md'));
});

test('탐색 보강: 유효해 미발견과 해 없음 구분, 결과 파일 저장과 시간 여유, 연속·혼합 변수, 오답 거부 테스트, 깨끗한 배포본', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const sk = read('skills/optimize-search/SKILL.md');
  const pr = read('PROMPTS.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  // 1) 못 찾음 ≠ 해 없음
  assert.match(sk, /탐욕이 막혀도 답이 없다는 뜻이 아니다\. 순서를 바꾼 재시작, 백트래킹, 제약 풀이를 검토한다/);
  assert.match(sk, /\*\*유효해 미발견\*\*\(시간 안에 못 찾음, 시도한 방법을 적음\), \*\*해 없음\*\*\(완전탐색이나 서로 모순되는 제약으로 불가능을 증명한 경우만\)/);
  assert.match(sk, /못 찾은 것을 "해 없음"이라 쓰기/);
  assert.match(sec('유형-7'), /"해 없음"으로 끝내지 말고 순서를 바꾼 재시작·백트래킹·제약 풀이/);
  assert.match(sec('유형-7'), /불가능을 증명하지 못했으면 "유효해 미발견"으로 보고해/);
  assert.match(read('templates/EXPERIMENTS.md'), /유효해 미발견\(시간 안에 못 찾음\) \/ 해 없음\(불가능을 증명한 경우만\)/);
  // 2) 결과 파일 저장과 시간 여유
  assert.match(sk, /검증기를 통과하면 \*\*바로 결과 파일로 저장\*\*한다/);
  assert.match(sk, /더 나은 유효해를 찾으면 검증기를 통과한 것만 결과 파일로 저장한다\(강제 종료·오류에도 남게\)/);
  assert.match(sk, /탐색은 제한 시간에서 최종 검증·출력 시간을 뺀 시점에 끝낸다/);
  assert.match(sk, /제한 시간에 입력 처리·검증·저장이 포함되는지/);
  assert.match(sec('유형-7'), /통과하면 바로 결과 파일로 저장해줘/);
  assert.match(sec('유형-8'), /검증기를 통과한 것만 결과 파일에 저장해서 중간에 끊겨도 남게/);
  assert.match(sec('유형-8'), /최종 검증·출력 시간을 남기고 탐색을 끝내게/);
  assert.match(read('templates/TASK.md'), /제한 시간에 입력 처리·검증·저장이 포함되는지/);
  // 3) 연속·혼합 변수
  assert.match(sk, /연속값: 좌표탐색·패턴탐색\(미분 불필요\), 경사 기반은 목적함수가 미분 가능하고 매끄러운지 확인한 뒤/);
  assert.match(sk, /혼합이면 이산 부분을 고정하고 연속 부분을 푸는 식으로 나눈다/);
  assert.match(read('templates/TASK.md'), /\| 결정 변수와 유형 \| \(무엇을 고르거나 바꾸나, 이산 \/ 연속 \/ 혼합\) \|/);
  // 4) 검증기는 제약을 어긴 답을 거부하는지도 테스트
  assert.match(sk, /제약을 어긴 답\(거부되어야 함\)/);
  assert.match(sec('유형-6'), /제약을 어긴 답은 거부/);
  assert.ok(sk.length < 2500, `optimize-search ${sk.length}`);
  // 5) 배포본은 커밋된 파일만
  const rd = read('README.md');
  assert.match(rd, /\*\*폴더를 통째로 압축하지 않습니다\.\*\*/);
  assert.match(rd, /git archive --format=zip -o \.\.\/worknotes-kit\.zip HEAD/);
  assert.match(rd, /공개 저장소는 이 묶음으로 새 이력에서 시작합니다/);
});

test('힌트 대비: 맥락 질문으로 인터뷰를 열고, 위험한 부분과 요구 근거 없는 장치를 점검하며, 서술형에서 일부러 안 만든 것을 말한다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pr = read('PROMPTS.md');
  const pb = read('PLAYBOOK.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  // 1) 맥락 질문 1~2개로 열고 그다음 영향 큰 순서 (사소한 것부터로 되돌리지 않음)
  const w = read('skills/work-intake/SKILL.md');
  assert.match(w, /처음 1~2개는 답하기 쉬운 맥락 질문\(누가, 어떤 상황에서, 무엇을 결정하려고 쓰나\)으로 연다\. 그다음은 결과 영향이 큰 미확인 사항부터/);
  assert.match(w, /답에서 단서가 나오면 꼬리질문으로 파고든다/);
  assert.doesNotMatch(w, /사소하고 구체적인 것부터/);
  assert.ok(w.length < 2500, `work-intake ${w.length}`);
  assert.match(pb, /1-2\(high\) 인터뷰 시작: 쉬운 맥락 질문 1~2개로 열고, 그다음 영향이 큰 질문부터/);
  // 2) 위험한 부분과 필요성 점검
  assert.match(sec('2-2'), /틀리면 크게 깨지는 위험한 부분 2~3개를 계약 절 끝에 적어줘/);
  assert.match(sec('4-5'), /4\) 필요성: 요구나 시나리오에 근거가 없는 장치\(보호 장치, 권한, 캐시, 재시도, 추상화\)가 있으면 목록으로\. 뺄지는 내가 정할게/);
  assert.match(sec('5-3'), /요구나 시나리오에 근거가 없는 기능·장치를 표로만 알려줘/);
  assert.match(pb, /4-5\(high\) \*\*채택 전 점검\*\*:.*요구에 근거 없는 장치/);
  assert.match(pb, /5-3\(high\) 읽기 전용 교차 점검:.*요구에 근거 없는 기능은 없나/);
  // 3) 서술형: 일부러 만들지 않은 것
  assert.match(pb, /3\. 가장 중요한 설계 선택과 이유 한 개, 일부러 만들지 않은 것 한 개/);
  assert.match(pb, /\| 구조 \| 파일·모듈을 어떻게 나눴고 왜 그렇게 나눴나, 일부러 만들지 않은 것은 무엇이고 왜인가 \|/);
  assert.match(read('templates/WORK.md'), /③가장 중요한 설계 선택과 이유, 일부러 만들지 않은 것/);
  assert.match(sec('6-2'), /③가장 중요한 설계 선택과 이유, 일부러 만들지 않은 것과 이유/);
});

test('새로 만드는 과제: 2-1을 건너뛰고 합류 1에서 유형-9로 단순 버전을 내 기준선으로, 엔진 없는 서비스의 나누는 법', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pr = read('PROMPTS.md');
  const pb = read('PLAYBOOK.md');
  const sec = pr.split('**유형-9.')[1];
  assert.ok(sec, 'PROMPTS.md에 유형-9가 있어야 함');
  assert.match(sec, /기존 시스템이 없으니 지금 돌아가는 단순 버전을 기준선으로 삼을게/);
  assert.match(sec, /kit\/skills\/improve-existing\/SKILL\.md 의 2~3번대로/);
  assert.match(sec, /과제가 품질 향상을 요구하면 ④에서 이 기준선 대비로 4-3·4-4를 씁니다\. 요구하지 않으면 건너뛰고/);
  assert.match(pb, /2-1\(high\) 기준선:.*기존 것이 없으면 건너뛰고 합류 1에서 유형-9/);
  assert.match(pb, /새로 만드는 과제\(기존 엔진·시스템 없음\): 2-1은 건너뛰고, fixture는 요구에서 손으로 만든 예시, 3-1은 가장 단순하게 맞는 엔진을 새로 만든다\. 합류 1에서 유형-9\(high\)로 \*\*그 단순 버전을 내 기준선\*\*으로 기록한다/);
  assert.match(pb, /계산할 엔진이 없는 조회·등록 서비스면 메인은 데이터 모델·API·권한, 화면 세션은 화면을 맡고 계약에 DB 스키마를 더한다/);
});

test('실험 기록 템플릿: EXPERIMENTS.md(비교 조건, 로그 표, 실험 카드, 최종 요약)와 스킬·WORK.md·안내 문서 연결', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const ex = read('templates/EXPERIMENTS.md');
  for (const k of ['## 비교 조건 (모든 실험에서 같게)', '## 실험 로그', '## 실험 카드', '## 최종 요약', '입력(파일·버전)', '시간 제한 / 난수 시드', '기준선 값']) assert.ok(ex.includes(k), `EXPERIMENTS.md: ${k}`);
  assert.match(ex, /\| # \| 가설\(한 문장\) \| 변경 요지 \| 지표 전 → 후 \| 나빠진 지표·요구 위반 \| 시간 \| 결정 \|/);
  for (const k of ['**가설**', '**변경**', '**조건**', '**결과**', '**나빠진 것**', '**왜 그랬나(내 말로)**', '**판별 사례**', '**숨은 선택**', '**결정**', '**다음 가설**']) assert.ok(ex.includes(k), `실험 카드: ${k}`);
  assert.match(ex, /카드는 \*\*시작할 때\*\* 가설·변경 계획·조건부터 쓰고\(끊겨도 남게\)/);
  assert.match(ex, /최적성을 증명하지 못했으면 "찾은 최선의 해"/);
  // WORK.md에는 실험 표를 두지 않고, 스킬은 EXPERIMENTS.md를 가리킨다
  const wk = read('templates/WORK.md');
  assert.doesNotMatch(wk, /## 실험 기록|## 탐색 결과 비교/);
  assert.match(read('skills/improve-existing/SKILL.md'), /실험은 가설마다 `EXPERIMENTS\.md` 카드에 쓴다\. 시작할 때 가설·변경 계획·조건을 먼저 적고/);
  assert.match(read('skills/optimize-search/SKILL.md'), /기본안과 개선안을 `EXPERIMENTS\.md`에 적는다\(실험마다 카드\)/);
  // 사람용 문서: 복사 목록·구성표·프롬프트가 같은 위치를 가리킨다
  assert.match(read('PLAYBOOK.md'), /\(개선·탐색 과제면 `EXPERIMENTS\.md`도\)/);
  assert.match(read('README.md'), /`EXPERIMENTS\.md`\(개선·탐색 실험 기록/);
  assert.match(read('PROMPTS.md'), /EXPERIMENTS\.md 카드에 가설·변경 계획·조건을 먼저 적어줘/);
  assert.doesNotMatch(read('PROMPTS.md') + read('PLAYBOOK.md'), /탐색 결과 비교|WORK\.md 실험 기록/);
  assert.doesNotMatch(read('instructions/AGENTS.md'), /EXPERIMENTS/, '지침 용량을 늘리지 않는다');
});

test('④ 실험 중심: 가설 → 실험 → 기록 2~3번, 25분 사이클, 마지막 시작 110분·채택 확정 135분으로 시간이 맞는다', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const s4 = pb.slice(pb.indexOf('## ④ 실험·완성'), pb.indexOf('### 합류 2'));
  for (const k of ['**가설 → 실험 → 기록**을 2~3번', '25분 안팎', '4-3(high) **후보**', '4-4(high) **시작 기록 → 실험**', '카드에 **먼저** 적고(끊겨도 남게)', '**복사본이나 버전 플래그에서만**', '**왜 그랬나(내 말로)**', '폐기한 실험도 카드를 남긴다', '4-5(high) **채택 전 점검**', '화면 세션:', '마지막 실험은 **110분까지** 시작한다', '135분까지 검증 안 된 것은 채택하지 않는다(135~145분은 동결 준비)']) assert.ok(s4.includes(k), `④: ${k}`);
  assert.match(pb, /\| \*\*④ 실험·완성 \(중심\)\*\* \| 75–145분 \|/);
  assert.match(pb, /`EXPERIMENTS\.md` 최종 요약\(기준선 → 최종, 채택한 것, 채택하지 않은 것과 이유, 한계\)을 채운다/);
  const pr = read('PROMPTS.md');
  assert.match(pr, /시간 상한: 25분/);
  assert.match(pr, /"왜 그랬나"는 근거만 정리해 주면 내 말로 쓰고, 채택\/보류\/폐기는 내가 정할게/);
  assert.match(read('skills/improve-existing/SKILL.md'), /시간 상한\(예: 25분\)/);
  // 125분 시작 + 30분 실험은 135분 기준과 모순이므로 남기지 않는다
  assert.doesNotMatch(pb + pr + read('skills/improve-existing/SKILL.md'), /125분 이후|30분 상한|시간 상한: 30분|예: 30분|가설 1~2개/);
});

test('이해 점검과 구현 속도: 🔍 세 곳(합류 1 대표 입력·화면 흐름, 채택 직전 이해 대조, 동결 때 다시 따라가기), ⚡는 판단 없는 구현에만, 기록 주체는 응시자', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pb = read('PLAYBOOK.md');
  const pr = read('PROMPTS.md');
  const sec = (id) => pr.split(`**${id}.`)[1].split(/\n\*\*(?:\d-\d|막힘-\d+|유형-\d|보조-\d)\./)[0];
  assert.match(pb, /\*\*⚡\*\*는 빠르게 돌려도 되는 구현이고, 아낀 시간은 \*\*이해 점검\*\*\(🔍\)에 씁니다/);
  // 🔍 세 곳
  const m1 = pb.slice(pb.indexOf('### 합류 1'), pb.indexOf('## ④'));
  assert.match(m1, /🔍 3-5\(medium\) 대표 입력 흐름/);
  assert.match(m1, /🔍 3-6\(low\) 화면 쪽 흐름:.*\*\*내 말로\*\* 설명 노트 "데이터" 칸에/);
  const s4 = pb.slice(pb.indexOf('## ④'), pb.indexOf('### 합류 2'));
  assert.match(s4, /🔍 4-8\(medium\) \*\*채택 직전 이해 대조\*\*:.*\*\*내가 먼저\*\*.*\*\*말하지 못하면 반영하지 않는다\*\*/);
  assert.ok(s4.indexOf('4-5(high)') < s4.indexOf('4-8(medium)'), '4-5 다음에 4-8');
  const m2 = pb.slice(pb.indexOf('### 합류 2'), pb.indexOf('## ⑤'));
  assert.match(m2, /🔍 3-5\(medium\)를 최종 코드로 다시 요청해 대표 입력 흐름을 처음부터 끝까지 다시 따라가고/);
  assert.match(sec('3-6'), /파일을 수정하지 마\. 화면 행 파일 중 핵심 파일 2개의 역할/);
  assert.match(sec('3-6'), /"사용자 동작\(버튼·입력\) → API 호출\(경로·요청\) → 응답 → 화면 표시"/);
  assert.match(sec('4-8'), /정답 문장을 대신 써 주지 말고, 틀린 곳은 확인할 파일·함수 위치만 짚어줘/);
  assert.match(sec('4-8'), /채우기:/);
  assert.match(sec('4-8'), /\*\*말하지 못하면 반영하지 않습니다\.\*\*/);
  // ⚡: 판단 없는 구현에만, 판단 단계에는 없음
  for (const id of ['3-2', '3-4', '3-3', '4-6']) assert.match(pb, new RegExp(`${id}\\([^)]+\\)⚡`), `${id}에 ⚡`);
  for (const id of ['1-1', '1-2', '2-1', '2-2', '4-3', '4-4', '4-5', '4-8', '5-2', '막힘-1', '막힘-2']) assert.doesNotMatch(pb, new RegExp(`${id}\\([^)]+\\)⚡`), `${id}에는 ⚡ 금지`);
  const d = pb.slice(pb.indexOf('## 부록 D'), pb.indexOf('## 부록 E'));
  assert.match(d, /\*\*구현 속도와 이해 시간\*\*/);
  assert.match(d, /제공 Codex에 빠른 모드가 있으면 그것을, 없으면 강도를 low~medium으로/);
  assert.match(d, /\*\*빠르게 돌리지 않는다\.\*\* 빠르게 만들어 고치는 데 시간을 더 쓰면 손해다/);
  assert.match(d, /아낀 시간은 마지막이 아니라 \*\*구현 바로 뒤의 이해 점검\(🔍\)\*\*에 쓴다/);
  // 기록 주체와 시점
  assert.match(read('skills/improve-existing/SKILL.md'), /"왜 그랬는지"는 근거만 정리하고\(해석 문장은 응시자가 쓴다\), 채택 여부는 응시자가 정한다/);
  assert.doesNotMatch(read('skills/improve-existing/SKILL.md'), /왜 그랬는지, 채택 여부와 이유, 다음 가설을 채운다/);
  assert.match(read('templates/EXPERIMENTS.md'), /## 최종 요약 \(동결\(145분\) 때 채운다/);
  assert.match(read('templates/EXPERIMENTS.md'), /\*\*이해 대조\*\*: 반영 전에 내가 먼저 말한/);
  assert.match(pb, /첫 실험은 85분 시작이 목표\(③의 연결이 늦으면 연결이 먼저\)/);
});
