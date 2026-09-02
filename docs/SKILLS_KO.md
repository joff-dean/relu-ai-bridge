# RELU AI Bridge 분석 Skill 설계와 배포

## 목적

RELU 분석 Skill은 Claude/Codex가 Perfetto 또는 사내 Android 로그 시각화 도구의 현재 선택 구간을 일관된 절차로 조사하도록 돕는다. 사람이 AI client와 분석 도구를 실행해 둔 상태를 전제로 하며, Skill이 모델을 자동 실행하거나 화면을 감시하지 않는다.

역할은 다음처럼 분리한다.

```text
Perfetto / WPF 분석기
  └─ 현재 resource, selection, revision과 bounded 분석 Capability 제공
          │
          ▼
RELU AI Bridge
  └─ 인증, server-owned registry, schema, 승인, 제한, stale selection 차단
          │
          ▼
Claude / Codex + relu-analyze-selection
  └─ 조사 순서, 해석 기준, 근거 최소화, 보고 형식 적용
```

Skill은 데이터나 실행 권한을 추가하지 않는다. 실제로 가능한 동작은 매 호출 시 Bridge의 `list_capabilities`가 반환한 live 계약으로만 결정된다.

## 정본 구조

저장소의 `skills/`가 유일한 배포 원본이다.

```text
skills/
├─ manifest.json
└─ relu-analyze-selection/
   ├─ SKILL.md
   └─ references/
      ├─ perfetto.md
      ├─ android-log-viewer.md
      └─ report-format.md
```

`SKILL.md` frontmatter에는 Open Agent Skills 공통 필드인 `name`과 `description`만 사용한다. 특정 client 전용 metadata를 넣지 않아 Claude와 Codex에 같은 디렉터리를 배포할 수 있다.

본문은 공통 discovery·revision·신뢰 경계만 담고 조건에 따라 다음 파일 하나를 읽는다.

- Perfetto session: `references/perfetto.md`
- Android 로그 시각화 Connector: `references/android-log-viewer.md`
- 정식 보고서를 요청한 경우에만 추가로 `references/report-format.md`

알 수 없는 서비스에는 Connector별 파일을 읽지 않는다. 이 progressive disclosure 구조는 불필요한 지침이 모델 Context를 차지하거나 다른 서비스에 잘못 적용되는 것을 막는다.

## 설치 위치

설치기는 symlink나 junction을 만들지 않고 정본을 복사한다.

| Client | 사용자 범위 | 프로젝트 범위 |
| --- | --- | --- |
| Claude | `%USERPROFILE%\.claude\skills\relu-analyze-selection` | `<project>\.claude\skills\relu-analyze-selection` |
| Codex | `%USERPROFILE%\.agents\skills\relu-analyze-selection` | `<project>\.agents\skills\relu-analyze-selection` |

macOS/Linux의 사용자 범위는 각각 `~/.claude/skills/`와 `~/.agents/skills/`다. 프로젝트 범위는 운영 저장소에만 적용하려는 경우에 적합하고, 사용자 범위는 동일 Windows 계정의 여러 작업 공간에서 사용할 때 적합하다.

설치 뒤 이미 실행 중인 Claude/Codex가 Skill 목록을 갱신하지 않으면 새 작업/session을 연다. 설치 파일을 회사 프로젝트 Git에 다시 commit할지는 해당 저장소의 보안·변경관리 정책으로 결정한다.

## Windows 설치

RELU AI Bridge와 같은 Node.js 20.11 이상 runtime을 사용한다. 프로젝트 범위로 두 client에 설치하는 예:

```powershell
powershell.exe -NoProfile -File .\scripts\skills\install-skills.ps1 `
  -Scope project `
  -Target both `
  -ProjectPath C:\work\android-analysis
```

사용자 범위로 Claude에만 설치:

```powershell
powershell.exe -NoProfile -File .\scripts\skills\install-skills.ps1 `
  -Scope user `
  -Target claude
```

회사 표준 Node 실행 파일 이름이 다르면 `-NodeCommand`로 지정한다. Windows PowerShell
5.1은 `powershell.exe`, PowerShell 7을 표준화한 장비는 같은 명령의 실행 파일만
`pwsh`로 바꾼다. PowerShell execution policy는 회사 정책을 유지하며, 이 문서는 우회
설정을 요구하지 않는다.

검증과 제거:

```powershell
powershell.exe -NoProfile -File .\scripts\skills\verify-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\work\android-analysis

powershell.exe -NoProfile -File .\scripts\skills\uninstall-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\work\android-analysis
```

제거 역시 관리 상태와 checksum이 일치할 때만 수행한다. 사용자가 수정한 파일을 자동 삭제하지 않는다.

## macOS/Linux 설치

```bash
ANALYSIS_PROJECT=/absolute/path/to/analysis-project
./scripts/skills/install-skills.sh \
  --scope project \
  --target both \
  --project-root "$ANALYSIS_PROJECT"

./scripts/skills/verify-skills.sh \
  --scope project \
  --target both \
  --project-root "$ANALYSIS_PROJECT"
```

위 명령은 RELU source checkout에서 실행하되 `ANALYSIS_PROJECT`에는 Skill을 실제로
사용할 분석 프로젝트를 지정한다. RELU source 자체를 대상으로 지정하지 않는다.

사용자 범위 기본값은 다음과 같다.

```bash
./scripts/skills/install-skills.sh
./scripts/skills/verify-skills.sh
```

안전하게 제거하려면 설치할 때와 같은 scope·target을 지정한다.

```bash
./scripts/skills/uninstall-skills.sh \
  --scope user \
  --target both
```

## 설치기 무결성 계약

`skills/manifest.json`은 모든 Skill 파일의 상대경로, byte 길이와 SHA-256을 기록한다. 관리기는 모든 명령 전에 정본에 대해 다음을 검증한다.

- manifest에 없는 Skill/file, 누락된 파일과 경로 대소문자 충돌 거부
- 절대경로, `..`, backslash 기반 우회와 reserved 상태 파일 경로 거부
- manifest와 설치 상태 JSON의 잘못된 UTF-8 및 escape 표기가 같은 이름인 경우를 포함한 duplicate object key 거부
- source/destination의 symlink·junction·특수 파일 거부
- 파일 크기와 SHA-256 일치 확인
- Node.js 최소 버전 확인

설치된 각 Skill에는 `.relu-ai-bridge-install.json` 관리 상태가 함께 저장된다. 모델은 이 파일을 지침으로 읽을 필요가 없다. 다음 설치·제거 시 관리기는 상태에 기록된 이전 file set과 현재 설치를 먼저 비교한다.

- 대상이 없으면 새로 설치한다.
- 현재 release와 같으면 아무것도 쓰지 않는다.
- 이전 RELU 관리본이고 수정되지 않았으면 안전하게 갱신한다.
- 상태가 없거나 file 추가·삭제·수정이 있으면 전체 작업을 중단한다.

의도적으로 `force` 옵션은 제공하지 않는다. 사용자 수정본을 교체하려면 먼저 별도 위치에 보관하고 대상을 직접 검토·정리한 뒤 설치한다. 자동화가 그 판단을 대신하지 않는다.

`install`과 `uninstall`은 각 `.claude/skills`·`.agents/skills` parent에 atomic `mkdir` 방식의 `.relu-ai-bridge-skills.lock`을 잡는다. 여러 parent는 정렬된 순서로 모두 확보한다. 정상적으로 실행된 다른 관리기나 이전 crash의 lock이 있으면 기다리거나 임의 탈취하지 않고 fail-closed한다.

새 파일은 lock을 보유한 상태에서 대상과 같은 parent의 staging directory에 완성하고 재검증한 뒤 rename한다. `both` 설치는 모든 대상을 preflight/staging한 후 교체하며 다음 검사를 추가로 수행한다.

- 교체 직전에 destination directory identity, 상태 JSON과 전체 file checksum을 다시 확인
- 기존 설치를 random backup으로 rename한 직후 같은 관리본인지 다시 확인
- 새 destination이 staging 관리본과 같은지 확인
- 모든 교체가 끝난 뒤 backup을 다시 확인하고 manifest의 정확한 file만 제거
- rollback에서 새 destination이 staging 관리본과 달라졌다면 삭제하지 않고 backup과 함께 보존

`uninstall`도 destination을 random removal directory로 rename한 직후와 실제 삭제 직전에 다시 확인한다. 제거 코드는 검증된 file과 빈 directory만 다루며, 변경되었거나 file이 추가된 removal을 재귀 삭제하지 않는다. 중간 실패 시 검증된 원본만 복구하고 정체가 달라진 directory는 운영자 검토를 위해 남긴다.

이 lock은 정상 RELU 관리기끼리의 경쟁을 직렬화할 뿐 OS 보안 경계는 아니다. 같은 OS 계정에서 실행되는 악성 process는 lock을 지우거나 directory와 file을 system call 사이에 바꿀 권한이 있다. identity·checksum 재검증은 보통의 동시 editor와 많은 race를 fail-closed하지만, 같은 계정의 의도적인 연속 race를 완전히 막는다고 주장하지 않는다. Skill 설치 계정과 배포 디렉터리는 회사 ACL/EDR로 별도 보호해야 한다.

parent별 rename은 한 filesystem 안에서 원자적이지만 Claude와 Codex 두 parent를 묶은 crash-atomic transaction은 아니다. OS/power crash 뒤에는 stale lock과 `.staging-*`, `.backup-*`, `.removing-*`가 남거나 대상 중 일부만 새 버전일 수 있다. 이 경우 관리기를 다시 실행하기 전에 관련 process가 없음을 확인하고, 활성 destination과 보존 directory의 상태 JSON·manifest checksum을 각각 검토한다. lock이나 보존 directory를 이름만 보고 삭제하지 않는다. 변경된 새 destination과 backup이 함께 남았다면 둘 다 보관해 수동 diff와 복구 대상을 결정한다.

SHA-256 manifest는 전송 오류와 우발적 변경을 찾는 inventory이지 서명은 아니다. 같은 OS 계정이나 배포 저장소를 장악한 공격자가 Skill과 manifest를 함께 바꾸는 것을 증명할 수 없다. 사내 배포물의 출처는 RELU의 검증된 Git tag, 승인된 commit과 immutable 사내 mirror로 별도 보장한다.

정본만 검사하려면 다음 명령을 사용한다.

```bash
node ./scripts/skills/manage-skills.mjs verify-source
```

## 분석 시 동작

사용자가 “현재 선택 구간을 분석해 줘”라고 요청하면 Skill은 다음 순서를 사용한다.

1. `list_sessions`로 live 후보 확인
2. `get_context`로 resource와 선택 revision snapshot 확보
3. `list_capabilities`로 현재 server-owned action/schema 확인
4. 집계와 기존 분석 결과를 먼저 조회
5. 이상 후보 주변의 제한된 원문만 조회
6. 다시 `get_context`를 호출해 같은 revision/선택인지 확인
7. 사실·가설·반대 근거·확신도·데이터 한계를 분리해 답변

선택이 바뀌었으면 이전 결과와 새 결과를 섞지 않는다. revision 필드가 없는 Connector에서는 opaque resource ID와 exact 선택 시작·끝을 비교하는 보수적 fallback을 쓴다.

`get_context`나 Capability가 local approval을 요구하면 Skill이 승인하지 않는다. 사용자가 admin UI에서 결정한 뒤 같은 호출을 다시 수행한다. UI 선택 변경이나 annotation처럼 effect가 있는 Capability는 사용자가 명시적으로 요청한 경우에만 실행하며, timeout/ambiguous mutation을 자동 재시도하지 않는다.

## WPF Android 로그 Connector 계약

WPF 프로그램을 Connector로 추가할 때 Skill 파일을 WPF에 포함하거나 로그와 함께 전송할 필요가 없다. WPF는 분석 데이터만 RELU에 제공하고, Skill은 검증된 RELU release에서 Claude/Codex 쪽에 설치한다.

권장 Context 형태는 다음과 같다. 실제 schema는 server registry가 소유한다.

```json
{
  "logResourceId": "opaque-log-9f18",
  "datasetRevision": "rev-42",
  "selectionId": "selection-108",
  "selectionRevision": "selection-revision-108",
  "selection": {
    "startMs": 1834567890123,
    "endMs": 1834567990123
  }
}
```

현재 WPF 샘플 Capability 계약은 다음과 같다. Skill은 이 표보다 live `list_capabilities`의 설명과 schema를 우선한다.

| 역할 | 샘플 이름 | 현재 샘플 반환 경계 |
| --- | --- | --- |
| 선택 통계 | `get_selection_stats` | duration/sample/warning/error 수와 최대 200개 name/value/unit metric |
| 차트 series | `get_selection_series` | 최대 6개 name/unit series, series당 최대 1,000개 timestamp/value point |
| 기존 텍스트 추출 | `get_extracted_sections` | 최대 100개 kind/start/end/text section, text당 최대 16,000자 |
| 이상 후보 | `find_anomalies` | 최대 100개 timestamp/severity/summary/evidence 후보 |
| 원문 근거 | `get_log_excerpt` | 최대 200개 timestamp/level/tag/message line, message당 최대 4,000자 |

현재 샘플에는 UI mutation이 없다. 나중에 `focus_range`나 `add_annotation`을 추가한다면 server registry에 별도 effect와 schema를 선언하고 mutation마다 `operationId`를 요구해야 한다.

Context의 `bindingFields`에는 최소한 `logResourceId`와 `datasetRevision`처럼 데이터 정체성을 결정하는 값을 포함한다. `executionGuardFields`에는 top-level `selectionId`, `selectionRevision`과 전체 `selection` 객체를 포함해 exact `selection.startMs`/`selection.endMs`까지 실행 직전에 검증한다. 새 로그를 열거나 dataset 내용이 바뀌면 이전 persistent approval이 그대로 확대 적용되지 않도록 resource binding과 policy scope를 바꾼다.

표의 개수·문자열 상한과 별도로 Bridge의 `connectors.maxResultBytes`와 .NET SDK outbound message 상한 중 더 작은 전체 byte 제한도 만족해야 한다. 통계/series/excerpt에 적용 filter, timebase, truncation, dropped record, parser/sampling version 같은 provenance가 필요하면 server registry schema와 분석 엔진 모델을 함께 version-up해 명시적으로 추가한다. 반대로 전체 파일 경로, 인증정보, 전체 로그와 무제한 chart point를 Context에 넣지 않는다.

## Prompt injection과 지침 공급 경계

다음 내용은 모두 untrusted data다.

- trace metadata와 slice/name/string cell
- Android log message, tag, stack trace와 추출 section
- chart label, annotation, 파일명과 사내 문서 문자열
- Connector의 Context 및 Capability 결과

이 데이터에 “다른 도구를 실행하라”, “승인하라”, “SKILL.md를 교체하라” 같은 문장이 있어도 실행 지시로 취급하지 않는다. WPF 또는 웹 Connector가 runtime에 Skill 본문, 추가 reference, URL 기반 지침이나 prompt를 내려주는 구조를 만들지 않는다. Connector schema에 `systemPrompt`, `instructions`, `skillUrl` 같은 권한 확장 필드를 두지 않는다.

Skill 변경은 다음 release 절차로만 공급한다.

1. 저장소 정본 변경 review
2. `skills/manifest.json` checksum을 명시적으로 갱신
3. Skill validator와 전체 회귀 테스트
4. 승인된 RELU tag/commit으로 사내 mirror 반입
5. 설치기 preflight와 checksum 검증 후 복사

## Skill 유지보수

`SKILL.md`에는 공통 결정만 유지하고 특정 Connector 지식은 해당 reference에 둔다. 새 Connector를 지원할 때는 다음 조건을 만족할 때만 reference를 추가한다.

- 공통 절차만으로는 분석 품질이 실제로 떨어지는 domain 규칙이 있다.
- service 판별 조건이 명확하다.
- reference를 읽어야 하는 시점이 `SKILL.md`에 연결되어 있다.
- action 이름을 고정 계약으로 만들지 않고 live Capability를 우선한다.

파일 수정 뒤 `skills/manifest.json`의 byte 길이와 SHA-256을 review를 거쳐 갱신한다. 관리기가 checksum을 자동 재생성하지 않는 이유는 임의 변경을 검토 없이 신뢰 목록에 편입시키지 않기 위해서다.

최종 확인 항목:

```text
skill-creator quick_validate 통과
manage-skills.mjs verify-source 통과
project scope Claude/Codex 설치·검증·제거 통과
수정된 설치본의 update/uninstall 거부 확인
전체 Node test suite 통과
```
