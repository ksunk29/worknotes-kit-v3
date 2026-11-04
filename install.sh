#!/bin/sh
# worknotes-kit 설치 도우미 (POSIX sh: `sh kit/install.sh <명령>` 으로 실행)
#
#   check   (기본) 현재 상태만 출력한다. 파일을 바꾸지 않는다.
#   skills  kit/skills/* 를 ./.agents/skills/ 로 복사를 '한 번' 시도한다.
#           쓸 수 없으면 오류와 대체 방법만 출력하고 끝낸다. (권한 변경·다른 경로 시도 없음)
#   agents  ./AGENTS.md 가 없을 때만 kit/instructions/AGENTS.md 를 복사한다.
#
# 하지 않는 일: 홈 디렉터리·/etc·플랫폼 설정 수정, 네트워크 호출, 기존 파일 덮어쓰기·덧붙이기.

set -u

KIT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK_DIR=$(pwd)
CMD=${1:-check}

say() { printf '%s\n' "$*"; }

fallback() {
  say ""
  say "[대체 방법] 자동 적용이 안 되면 코딩 에이전트에게 파일을 직접 읽고 적용하라고 요청하세요."
  say "  예) \"kit/skills/work-intake/SKILL.md 를 읽고 그 절차대로 과제 요구를 정리해줘.\""
  say "  우회(권한 변경, 다른 경로 쓰기 등)는 하지 마세요."
}

kit_origin() {
  if [ -d "$KIT_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    url=$(git -C "$KIT_DIR" config --get remote.origin.url 2>/dev/null || true)
    rev=$(git -C "$KIT_DIR" rev-parse --short HEAD 2>/dev/null || true)
    say "  출처 URL: ${url:-(없음)}"
    say "  커밋: ${rev:-(없음)}  -> WORK.md 의 '사용한 외부 자료'에 기록하세요."
  else
    say "  출처: (git 정보 없음)"
  fi
}

check() {
  say "== worknotes-kit 점검 (파일을 바꾸지 않습니다) =="
  say "키트 위치: $KIT_DIR"
  say "작업 폴더: $WORK_DIR"
  kit_origin
  say ""
  if [ -f "$WORK_DIR/AGENTS.md" ]; then
    say "AGENTS.md: 이미 있음 -> 덮어쓰거나 덧붙이지 않습니다."
    say "  코딩 에이전트에게 요청: \"제공된 지침을 먼저 읽고, 충돌하지 않는 범위에서 kit/instructions/working-rules.md 를 적용해줘.\""
  else
    say "AGENTS.md: 없음 -> 'sh $KIT_DIR/install.sh agents' 로 복사할 수 있습니다."
  fi
  if [ -d "$WORK_DIR/.agents/skills" ]; then
    if [ -w "$WORK_DIR/.agents/skills" ]; then
      say ".agents/skills: 있음, 쓰기 가능으로 보임"
    else
      say ".agents/skills: 있음, 쓰기 불가 -> 'skills' 는 실패할 것입니다. 대체 방법을 쓰세요."
    fi
  elif [ -d "$WORK_DIR/.agents" ]; then
    if [ -w "$WORK_DIR/.agents" ]; then say ".agents: 있음, skills 폴더는 없음(쓰기 가능으로 보임)"; else say ".agents: 있음, 쓰기 불가 -> 'skills' 는 실패할 것입니다."; fi
  else
    if [ -w "$WORK_DIR" ]; then say ".agents: 없음 (작업 폴더는 쓰기 가능으로 보임)"; else say ".agents: 없음, 작업 폴더도 쓰기 불가"; fi
  fi
  say "kit 경로: AGENTS.md 의 절차 파일 경로는 'kit/...' 를 가정합니다. (현재 키트 폴더 이름: $(basename "$KIT_DIR"))"
  say ""
  say "다음 단계(선택): skills | agents"
}

install_skills() {
  target="$WORK_DIR/.agents/skills"
  if ! mkdir -p "$target" 2>/dev/null; then
    say "[실패] $target 를 만들 수 없습니다. (플랫폼 제한일 수 있음)"
    fallback
    exit 1
  fi
  failed=0
  for src in "$KIT_DIR"/skills/*/; do
    name=$(basename "$src")
    dest="$target/$name"
    if [ -e "$dest" ]; then
      if diff -r "$src" "$dest" >/dev/null 2>&1; then
        say "[건너뜀] $name: 이미 같은 내용이 있음"
      else
        say "[건너뜀] $name: 이미 있고 내용이 다름 -> 덮어쓰지 않음"
      fi
      continue
    fi
    if cp -R "$src" "$dest" 2>/dev/null; then
      say "[복사] $name"
    else
      say "[실패] $name 복사 실패 (쓰기 제한일 수 있음)"
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    fallback
    exit 1
  fi
  say "완료. 코딩 에이전트가 스킬을 인식하는지 /skills 로 확인하고, 안 보이면 코딩 에이전트를 다시 시작해 보세요."
}

install_agents() {
  if [ -f "$WORK_DIR/AGENTS.md" ]; then
    say "[변경 없음] AGENTS.md 가 이미 있습니다. 덧붙이거나 덮어쓰지 않습니다."
    say "코딩 에이전트에게 요청: \"제공된 지침을 먼저 읽고, 충돌하지 않는 범위에서 kit/instructions/working-rules.md 를 적용해줘.\""
    return 0
  fi
  if cp "$KIT_DIR/instructions/AGENTS.md" "$WORK_DIR/AGENTS.md" 2>/dev/null; then
    say "[복사] AGENTS.md (키트가 ./kit 에 있다고 가정한 경로가 들어 있습니다)"
  else
    say "[실패] AGENTS.md 를 만들 수 없습니다."
    fallback
    exit 1
  fi
}

case "$CMD" in
  check) check ;;
  skills) install_skills ;;
  agents) install_agents ;;
  *) say "사용법: sh $0 [check|skills|agents]"; exit 2 ;;
esac
