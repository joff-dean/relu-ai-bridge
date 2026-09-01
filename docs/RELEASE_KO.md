# RELU AI Bridge 외부 릴리스 및 사내 반입 묶음 생성 가이드

이 문서는 범용 사내 웹서비스 AI 연결 플랫폼 **RELU AI Bridge**의 외부 개발
결과를 검증 가능한 오프라인 묶음으로 만드는 절차다. Perfetto는 전체 제품이
아니라 Connector #1이다. 회사 Perfetto fork, company-only adapter, 실제 trace,
분석 결과, 사내 경로·계정·제품 정보는 이 절차의 입력이나 산출물에 포함하지
않는다. 사내 반입·통합은 `INTERNAL_SYNC_KO.md`를 따른다.

## 1. 버전과 호환성 계약

기계 판독 가능한 계약은 두 계층으로 분리한다.

| 계층 | manifest | 의미 |
|---|---|---|
| RELU core | `compat/relu-ai-bridge.json` | 제품명, core version, release tag/ref 정책, connector 목록 |
| Connector #1 | `compat/connectors/perfetto-v57.2.json` | adapter contract, 공개 Perfetto 기준선, overlay 경로, 회사 정보 분리 정책 |

현재 core version은 `0.3.0`, release tag는 정확히
`relu-ai-bridge-v0.3.0`이다. core version을 바꾸지 않고 tag만 새로 만들 수 없다.
`package.json`의 package name/version도 `relu-ai-bridge`/`0.3.0`과 정확히 같아야
하며 생성·반입 도구가 이를 재검증한다.
현재 Perfetto Connector #1 release version도 `0.3.0`이다. connector release
version, adapter contract `v57`, public product baseline `v57.2`는 서로 다른 축이며
manifest에서 각각 기록한다.
새 connector를 추가할 때는 core manifest의 connector 목록과 해당 connector의
별도 manifest/schema를 추가한다.

Perfetto Connector #1의 공개 기준선은 다음과 같다.

| 항목 | 고정값 |
|---|---|
| 공식 저장소 | `https://github.com/google/perfetto.git` |
| 공개 tag | `v57.2` |
| annotated tag object | `24bdfb9dfa2dc92883761426dd94259756fa197e` |
| peeled commit | `da1d152cff27890903d158fe96751de3aab883cc` |
| adapter contract | `v57` |
| RELU connector version | `0.3.0` |

공개 확인 자료는 [Perfetto v57.2 release](https://github.com/google/perfetto/releases/tag/v57.2),
[Perfetto UI plugin 문서](https://perfetto.dev/docs/contributing/ui-plugins),
[Git bundle 문서](https://git-scm.com/docs/git-bundle)를 사용한다. 실제 자동화는
moving web page 내용이 아니라 manifest의 raw tag/commit SHA에 고정된다.

회사 fork의 label, 실제 SHA, adapter tree, 검증 상태는 외부 compatibility
manifest와 release artifact에 기록하지 않는다. 공개 manifest에는
`company_integration_policy`라는 분리 규칙만 있고, 실제 값은 사내 전용
configuration/CI evidence에서 관리한다. 공개 기준선 검증과 회사 fork 호환 판정은
서로 다른 단계다.

## 2. 신뢰 단위와 위협 모델

릴리스 신뢰 단위는 다음의 결합이다.

1. 이동하지 않는 annotated release tag와 raw tag object SHA
2. tag가 가리키는 정확한 peeled commit SHA
3. 그 tag 하나만 광고하고 그 tag에서 도달 가능한 object만 가진 Git bundle
4. core/connector contract blob ID와 connector source tree ID
5. source/history/tag/dependency inventory
6. 모든 파일을 덮는 `SHA256SUMS`
7. 반출·반입 담당자의 독립 검토와 별도 채널 승인 기록

Git bundle은 ref 하나만 fetch해도 pack에 든 다른 branch의 dangling object까지
대상 ODB에 반입할 수 있다. 따라서 tag/tree 비교만으로는 충분하지 않다.
검증기는 다음 조건을 모두 강제한다.

- `git bundle list-heads` 결과가 예상 annotated tag 하나와 정확히 같다.
- 빈 bare 검역 저장소에 fetch한 뒤 ODB의 **전체 object ID 집합**이 exact tag의
  reachable object ID 집합과 완전히 같다.
- import는 원본 bundle을 mirror에 직접 fetch하지 않고, 검역 저장소에서 exact
  tag만 다시 묶은 sanitized bundle을 경유한다.
- mirror의 기존 tag는 peeled commit뿐 아니라 raw annotated tag object도 같아야
  한다.

SHA-256은 전송 중 손상·변조를 탐지하지만 작성자 신원을 증명하지 않는다.
산출물과 같은 매체의 `SHA256SUMS`만 신뢰하지 말고, 승인된 bundle digest 또는
`SHA256SUMS` digest를 인증된 별도 채널 기록과 대조한다. 조직에 서명 체계가
있으면 signed annotated tag와 `--require-signed-tag`를 의무화한다.

## 3. 릴리스 전 게이트

릴리스 후보는 다음을 모두 만족해야 한다.

- `git status --short`가 비어 있고 HEAD가 release tag의 peeled commit이다.
- core/connector manifest와 schema를 검토했다.
- 전체 Node 테스트와 보안 경계 회귀 테스트를 통과했다.
- 공개 Perfetto exact v57.2 checkout에 copy overlay하여 connector test/typecheck를
  통과했다.
- 회사 코드, 실제 trace, SQL 결과, screenshot, log, AI transcript, credential을
  어느 reachable commit에도 넣지 않았다.
- commit/tag의 author, committer, tagger, 메시지, 서명 header에 사내 식별 정보나
  credential이 없다.
- dependency manifest/lockfile 변경을 검토했다.

clean commit에서 릴리스 경계 회귀를 한 번에 확인하려면 다음을 실행한다.

```bash
scripts/perfetto/release-security-smoke-test.sh
```

이 테스트는 정상 create/verify/import와 idempotent import를 확인하고, 정상 tag만
광고하면서 pack에 별도 branch object를 숨긴 bundle이 거부되는지, 거부된 blob이
mirror에 들어가지 않는지, 같은 commit의 다른 annotated tag object가 immutable
충돌로 처리되는지를 재현한다. 또한 clean annotated-tag fixture에서 core manifest,
root/SDK package, Chrome Companion, Perfetto plugin, MCP serverInfo와 health의 제품명·
version 정합성을 먼저 검사한다. root/SDK/extension/plugin/MCP/health version drift는
producer gate뿐 아니라 별도의 trusted verifier와 importer에서도 반드시 거부되고,
거부된 import가 mirror에 ref나 object를 남기지 않는지 확인한다. Source drift fixture는
올바른 값을 주석에 남겨 단순 문자열 검색으로 실제 drift를 가릴 수 없는지도 검증한다.
이 판정은 Python `assert` 최적화에 의존하지 않으므로 `PYTHONOPTIMIZE` 설정과 관계없이
fail-closed로 동작한다.

`release-security-scan.py`는 최종 tree뿐 아니라 release tag에서 도달 가능한 모든
과거 tree를 순회한다. symlink, gitlink/submodule과 `.env`, key, trace,
`node_modules` 경로를 거부하고,
text/binary를 구분하지 않고 모든 unique blob 및 raw commit/tag object에서
RSA/DSA/EC/OpenSSH/encrypted/PGP private-key header, AWS/GitHub/Slack token처럼
확실도가 높은 credential 형태를 찾는다. scanner 오류는 무발견으로 처리하지
않고 릴리스를 실패시킨다. bundle은 512 MiB, 개별 blob은 64 MiB, 전체 unique
blob은 1 GiB 상한을 적용해 비정상 반입을 제한한다.

민감 파일을 나중 commit에서 삭제해도 과거 object가 bundle에 남는다. 그런
이력이 있으면 릴리스를 중단하고 credential 폐기 및 승인된 history 정화 후 새
신뢰 기준에서 다시 시작한다. 자동 검사는 사람의 outbound review를 대체하지
않는다.

Perfetto Connector #1 공개 기준선 검증 예시:

```bash
scripts/perfetto/bootstrap.sh /work-external/perfetto-v57.2
scripts/perfetto/integrate.sh \
  --mode copy \
  /work-external/perfetto-v57.2
scripts/perfetto/smoke-test.sh /work-external/perfetto-v57.2
scripts/perfetto/build-test.sh --typecheck /work-external/perfetto-v57.2
```

개발 중에는 공개 checkout에 한해 `--mode symlink --allow-dirty-source`를 사용할 수
있다. release/사내 통합은 clean RELU checkout의 copy overlay만 사용한다.
`--install-deps`는 공식 Perfetto dependency 설치를 실행하므로 승인된 네트워크와
package mirror 정책을 먼저 확인한다.

## 4. annotated core tag 생성

manifest의 version과 tag가 일치하는지 확인한 뒤 tag를 만든다.

```bash
git status --short
git tag -a relu-ai-bridge-v0.3.0 \
  -m "RELU AI Bridge v0.3.0"
git show --no-patch --decorate relu-ai-bridge-v0.3.0
```

서명 정책을 사용하는 경우:

```bash
git tag -s relu-ai-bridge-v0.3.0 \
  -m "RELU AI Bridge v0.3.0"
git verify-tag relu-ai-bridge-v0.3.0
```

게시된 tag를 이동·삭제·재생성하지 않는다. 수정은 core version을 올리고 새 tag로
발행한다.

## 5. 반입 묶음 생성

산출물은 Git checkout 밖의 보안 staging에 만든다.

```bash
scripts/perfetto/create-release.sh \
  --tag relu-ai-bridge-v0.3.0 \
  --output /secure-transfer/out/relu-ai-bridge-v0.3.0
```

서명 tag를 강제할 때:

```bash
scripts/perfetto/create-release.sh \
  --require-signed-tag \
  --tag relu-ai-bridge-v0.3.0 \
  --output /secure-transfer/out/relu-ai-bridge-v0.3.0
```

출력 디렉터리는 기존 경로를 덮어쓰지 않는다. 임시 staging에서 scanner와
inbound verifier까지 통과한 뒤 한 번의 rename으로 공개한다.

| 파일 | 목적 |
|---|---|
| `relu-ai-bridge-v0.3.0.bundle` | exact core tag와 reachable object 전달 |
| `release-manifest.json` | raw tag/commit, core version, connector별 contract·기준선·tree ID |
| `source-inventory.txt` | 최종 tree의 tracked path, mode, object ID |
| `history-inventory.txt` | commit/parent/시간/author/committer/제목 |
| `tag-metadata.txt` | annotated tag 원문과 선택적 서명 |
| `dependency-manifest.txt` | dependency/lock manifest object ID |
| `SHA256SUMS` | 앞의 여섯 파일 무결성 |

`release-manifest.json`에는 회사 target label, 정확한 SHA, adapter tree, 검증 상태,
CI 결과를 어떤 형태로도 담지 않는다. 이 정보는 사내 저장소에만 둔다.

## 6. 독립 검증과 sanitized bundle

다른 담당자가 고정된 import tool checkout과 별도 trust store에서 실행한다.

```bash
scripts/perfetto/verify-release.sh \
  /secure-transfer/out/relu-ai-bridge-v0.3.0
```

검역 결과로 exact-tag bundle도 별도 생성할 수 있다. 출력은 존재하지 않아야
하며 원본 bundle과 다른 경로를 사용한다.

```bash
scripts/perfetto/verify-release.sh \
  --sanitized-bundle /quarantine/verified/relu-ai-bridge-v0.3.0.bundle \
  /secure-transfer/out/relu-ai-bridge-v0.3.0
```

서명 정책이면 `--require-signed-tag`를 함께 사용한다. 검증기는 bundle을 빈 bare
repo에 fetch한 후 다음을 독립 재계산한다.

- exact advertised tag, raw tag SHA, peeled commit
- 전체 ODB object 집합과 tag reachability 집합
- 모든 reachable blob/metadata/path/symlink 보안 검역
- bundle 코드를 실행하지 않고 tagged blob에서 root/SDK package, Chrome Companion,
  Perfetto plugin, MCP serverInfo와 health의 RELU 제품명·version 정합성
- source/history/tag/dependency inventory
- tagged core/connector manifest blob ID
- Perfetto plugin/adapter tree ID
- 로컬 검증 도구의 core/connector compatibility contract와의 일치

그 뒤 담당자는 inventory와 checkout을 수동 검토한다. 특히 회사명·host·IP,
고객/직원 정보, 절대 경로, 내부 issue URL, 실제 trace, prompt/response, browser
profile, credential, company-only adapter가 없어야 한다. 승인 기록에는 tag, raw
tag SHA, peeled commit, bundle SHA-256, 검토자·시각만 남기고 민감 본문을 복사하지
않는다.

## 7. 공개 Perfetto 기준선은 별도 artifact

회사 fork에 공개 기준 commit object가 없을 때를 위해 Google Perfetto baseline
bundle을 별도로 만들 수 있다.

```bash
scripts/perfetto/bootstrap.sh /work-external/perfetto-v57.2
scripts/perfetto/export-upstream-baseline.sh \
  /work-external/perfetto-v57.2 \
  /secure-transfer/out/perfetto-v57.2-public-baseline
```

이 artifact는 Google Perfetto source이며 RELU AI Bridge core release와 디렉터리,
checksum, 승인 기록을 섞지 않는다. 공개 baseline mirror에도 tag object
`24bdfb9…`와 peeled commit `da1d152…`를 각각 확인한다.
`bootstrap.sh`는 완전한 tag ancestry를 보존하는 non-shallow checkout을 만든다.
자립형 bundle을 위해 partial/promisor clone도 사용하지 않으므로 승인된 외부
네트워크와 충분한 디스크에서 실행한다. exporter는 생성 bundle을 완전히 빈 bare
repo에 실제 fetch해 object closure가 자립하는지도 확인한다. 기존 shallow 또는
partial checkout은 명시적으로 거부된다.

## 8. 롤백과 connector 업그레이드

릴리스 tag와 `refs/releases/relu-ai-bridge/*`는 이동하지 않는다. 롤백은 배포
포인터를 이전 검증 tag로 되돌리며 두 tag/ref와 artifact를 모두 보존한다. 긴급
수정도 기존 tag를 바꾸지 않고 core patch version을 올린다.

Perfetto 버전 업그레이드는 기존 `v57` contract를 조용히 변형하지 않는다.

1. 새 connector compatibility manifest와 adapter contract를 추가한다.
2. 공식 tag object와 peeled commit을 독립 확인한다.
3. 새 공개 checkout에서 API diff, overlay, typecheck/unit/build를 검증한다.
4. 새 default-plugin patch를 만든다.
   patch 대상은 해당 버전의 `default_plugins.ts` 한 파일, 한 줄 추가로 제한한다.
5. 기존 connector 회귀 테스트를 유지한다.
6. core manifest의 지원 connector/version을 갱신한다.
7. 새 RELU core version/tag/bundle로 사내 반입한다.

회사 fork 호환 판정과 company-only adapter 변경은 외부 release에 합치지 않고
사내 integration 저장소의 별도 승인·CI 기록으로 유지한다.
