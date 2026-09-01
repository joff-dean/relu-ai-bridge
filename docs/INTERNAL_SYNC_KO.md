# RELU AI Bridge 사내 동기화 및 Connector 통합 운영 가이드

RELU AI Bridge는 여러 사내 웹서비스를 AI와 연결하는 범용 플랫폼이고 Perfetto는
Connector #1이다. 이 문서는 외부에서 검증한 RELU core release를 사내로 단방향
반입하고, Connector #1을 사내 전용 label과 exact SHA로 식별한 회사 Perfetto에
통합하는 절차다.
회사 fork와 company-only adapter의 정확한 정보는 외부 release와 분리한다.
현재 RELU core와 Perfetto connector release version은 각각 `0.3.0`이며,
Perfetto public baseline `v57.2`와 adapter contract `v57`은 독립 호환성 축이다.

```text
외부 RELU core + connector별 public contract
                 │ annotated tag + release bundle
                 ▼
       오프라인 검역(빈 repo, 전체 object 검사)
                 │ sanitized exact-tag bundle
                 ▼
       사내 immutable RELU vendor mirror
                 │ read-only detached checkout
                 ├─────────────── 향후 Connector #2..N
                 ▼
 Connector #1: company Perfetto exact SHA
                 │ generic copy overlay
                 ▼
  company-only adapter + 사내 CI + 실제 trace 승인
```

## 1. 신뢰 경계와 절대 원칙

1. 외부 → 사내 방향은 승인된 release 디렉터리 전체만 허용한다.
2. 사내 → 외부 remote, 자동 push, 양방향 sync를 만들지 않는다.
3. 외부 checkout에 회사 fork, 실제 trace, 로그, SQL 결과, screenshot,
   company-only adapter를 복사하지 않는다.
4. `refs/tags/relu-ai-bridge-v*`와
   `refs/releases/relu-ai-bridge/*`는 immutable이다.
5. import tool은 반입 bundle 내부 코드가 아니라 사전에 검토·고정한 사내
   checkout에서 실행한다.
6. Perfetto public baseline과 company fork 호환성은 별도 판정한다. ancestry가
   direct descendant여도 API/동작 호환을 뜻하지 않는다.
7. 회사 target label은 사내 configuration에만 둔다. company 통합은 사내에서
   읽은 정확한 40자리 HEAD와 adapter manifest가 일치할 때만 실행한다.
8. 회사 차이는 외부 generic adapter를 변형하지 않고 사내 integration
   저장소의 company-only adapter에서만 흡수한다.
9. company 대상 overlay는 clean RELU release checkout에서 `copy`만 허용한다.
   symlink와 `--allow-dirty-source`는 도구가 거부한다.

## 2. 권장 저장소·계정 분리

```text
/opt/import-tools/relu-ai-bridge       # 보안 검토한 import tool, read-only
/quarantine/relu-ai-bridge-v0.3.0     # inbound release, 실행 금지
/srv/git/vendor/relu-ai-bridge.git     # bare immutable mirror
/srv/git/vendor/perfetto-public.git    # 선택: Google baseline bare mirror
/work/vendor-relu-ai-bridge            # detached vendor checkout
/work/company-perfetto                 # 회사 Perfetto disposable worktree
/work/company-perfetto-integration     # 회사 전용 adapter/patch/test/result
```

검역 계정은 `/quarantine` 읽기와 로컬 bare mirror 쓰기만 허용한다. 외부 인터넷,
사내 production data, 개발자 credential에 접근시키지 않는다. 중앙 Git 게시용
credential은 검역이 끝난 뒤 별도 단계에서만 주입하고 즉시 회수한다.

`company-perfetto-integration` 예시:

```text
company-perfetto-integration/
├── adapters/
│   └── <company-target-id>/
│       ├── COMPANY_ADAPTER.json
│       └── index.ts ...
├── compat-results/
│   └── <relu-tag>-<company-full-sha>.md
├── company-patches/
├── tests/
└── ci/
```

이 저장소에만 회사 target label, 회사명, 내부 API, 정확한 company SHA, 실제
trace test ID와 사내 CI 결과를 둔다. 외부 write remote를 등록하지 않는다.

## 3. inbound release 검역

외부 담당자가 `RELEASE_KO.md` 절차로 만든 디렉터리를 승인된 매체로 전달한다.
파일을 추가·삭제·이름 변경하지 않는다.

```bash
cd /opt/import-tools/relu-ai-bridge
scripts/perfetto/verify-release.sh \
  /quarantine/relu-ai-bridge-v0.3.0
```

signed tag 정책이면 검역 계정 trust store에 승인 public key만 설치하고
`--require-signed-tag`를 추가한다. 검증기는 다음을 독립 재계산한다.

- 허용된 파일 집합과 각 SHA-256, bundle size 상한
- RELU core version/tag/raw tag object/peeled commit
- bundle advertised head가 예상 tag 하나인지
- 빈 bare repo의 전체 ODB object ID 집합과 exact tag reachability 집합의 동일성
- 모든 reachable binary/text blob, raw commit/tag metadata, 과거 path와 symlink
- bundle 내부 스크립트를 실행하지 않고 tagged blob에서 root/SDK/Chrome Companion/
  Perfetto plugin/MCP/health 제품명·version 정합성
- source/history/tag/dependency inventory
- tagged core/connector manifest blob과 plugin/adapter tree
- 사내 import tool에 내장된 RELU/Perfetto compatibility contract

검증 결과가 통과해도 계산한 bundle SHA-256을 외부 승인 담당자가 별도 인증
채널에 기록한 값과 대조한다. `SHA256SUMS`와 bundle이 같은 매체에 있다는 사실만
신뢰 근거로 삼지 않는다. inventory와 tag metadata도 사람이 검토한다.

## 4. immutable mirror 반입

최초 한 번, 사내 전용 경로에 bare mirror를 만든다.

```bash
git init --bare /srv/git/vendor/relu-ai-bridge.git
```

반입:

```bash
scripts/perfetto/import-release.sh \
  /quarantine/relu-ai-bridge-v0.3.0 \
  /srv/git/vendor/relu-ai-bridge.git
```

이 도구는 원본 bundle을 mirror에 직접 fetch하지 않는다.

1. 빈 임시 repo에서 release를 다시 검증한다.
2. exact annotated tag만 새 sanitized bundle로 만든다.
3. sanitized bundle을 mirror의 임시 `refs/imports/relu-ai-bridge/*`로 fetch한다.
4. raw tag object와 peeled commit을 재검증한다.
5. 다음 두 최종 ref 생성/검증과 임시 ref 삭제를 하나의
   `git update-ref --stdin` transaction으로 commit한다.

```text
refs/tags/relu-ai-bridge-v0.3.0
refs/releases/relu-ai-bridge/relu-ai-bridge-v0.3.0
```

기존 tag는 같은 commit을 가리키는지만 보지 않는다. annotated tag type과 raw
tag object SHA까지 정확히 같아야 idempotent로 인정한다. lightweight tag 또는
같은 commit을 가리키는 다른 tag object는 충돌이다. release ref도 정확한 commit
외에는 갱신하지 않는다.

중앙 사내 Git으로 게시하기 전 읽기 전용 확인:

```bash
git -C /srv/git/vendor/relu-ai-bridge.git remote add internal \
  ssh://git.internal.example/vendor/relu-ai-bridge.git
git -C /srv/git/vendor/relu-ai-bridge.git ls-remote internal \
  refs/tags/relu-ai-bridge-v0.3.0 \
  refs/releases/relu-ai-bridge/relu-ai-bridge-v0.3.0
```

새 release라면 두 ref가 없어야 한다. 서버가 atomic push와 protected tag를
지원하는지 확인하고 한 transaction으로 게시한다.

```bash
git -C /srv/git/vendor/relu-ai-bridge.git push --atomic internal \
  refs/tags/relu-ai-bridge-v0.3.0:refs/tags/relu-ai-bridge-v0.3.0 \
  refs/releases/relu-ai-bridge/relu-ai-bridge-v0.3.0:refs/releases/relu-ai-bridge/relu-ai-bridge-v0.3.0
```

atomic push가 지원되지 않으면 개별 push로 우회하지 않는다. 문서의 host는
예시이며 실제 사내 URL은 이 외부 문서나 외부 commit에 기록하지 않는다.

## 5. read-only RELU checkout

```bash
git clone /srv/git/vendor/relu-ai-bridge.git /work/vendor-relu-ai-bridge
git -C /work/vendor-relu-ai-bridge checkout --detach \
  relu-ai-bridge-v0.3.0
git -C /work/vendor-relu-ai-bridge rev-parse HEAD
git -C /work/vendor-relu-ai-bridge status --short
```

HEAD는 release manifest의 `release.commit`과 같고 status는 비어 있어야 한다.
통합용 checkout은 read-only 입력으로 다루며 회사 파일을 그 안에 생성하지
않는다. 새 release는 기존 checkout을 갱신하지 않고 새 disposable checkout으로
검증한다.

### SDK 사내 배포

같은 detached release의 `sdk/`를 별도 artifact로 취급한다. 내부 packaging
저장소에서 회사 scope와 registry metadata를 적용하고 core version과 같은 `0.3.0`
및 artifact digest를 기록한다. 또는 서비스 저장소에 검토한 파일을 vendor하고
상대 `file:` dependency로 고정한다. 외부 checkout의 `private:true`를 직접 바꾸거나
그 checkout에서 publish하지 않으며, 외부 Git URL·개발자 절대경로를 사내
lockfile에 남기지 않는다.

## 6. Connector #1 공개 Perfetto baseline 반입

공개 baseline artifact는 RELU core release와 별도 디렉터리·checksum·승인 기록을
사용한다. 예상값은 다음 둘이다.

```text
refs/tags/v57.2 raw object = 24bdfb9dfa2dc92883761426dd94259756fa197e
refs/tags/v57.2^{} commit  = da1d152cff27890903d158fe96751de3aab883cc
```

baseline bundle도 extra object 위험이 있으므로 checksum/tag 확인 후 곧바로 운영
mirror에 fetch하지 않는다. 새 빈 bare 검역 repo에 fetch한 뒤 다음을 확인한다.
외부 exporter는 non-shallow·non-partial public checkout에서 bundle을 만들고 빈
repo fetch를 이미 통과해야 하며, 사내에서는 이를 독립 반복한다.

```bash
git bundle list-heads \
  /quarantine/perfetto-v57.2-public-baseline/perfetto-v57.2-upstream.bundle
# 정확히 위 tag object와 refs/tags/v57.2 한 줄이어야 함

git init --bare /quarantine/perfetto-v57.2-verify.git
git -C /quarantine/perfetto-v57.2-verify.git fetch --no-tags \
  /quarantine/perfetto-v57.2-public-baseline/perfetto-v57.2-upstream.bundle \
  refs/tags/v57.2:refs/tags/v57.2
git -C /quarantine/perfetto-v57.2-verify.git cat-file -t refs/tags/v57.2
git -C /quarantine/perfetto-v57.2-verify.git rev-parse refs/tags/v57.2
git -C /quarantine/perfetto-v57.2-verify.git rev-parse 'refs/tags/v57.2^{}'
```

검역 담당자는 `git cat-file --batch-all-objects`의 전체 ID 집합과
`git rev-list --objects refs/tags/v57.2`의 ID 집합도 정렬 비교한다. 동일한 빈
검역 repo에서 exact tag만 새 bundle로 만든 뒤에만
`/srv/git/vendor/perfetto-public.git`에 fetch한다. 원본 inbound bundle을 사내
company fork나 baseline mirror에 직접 fetch하지 않는다.

```bash
git -C /quarantine/perfetto-v57.2-verify.git \
  cat-file --batch-all-objects --batch-check='%(objectname)' \
  | LC_ALL=C sort -u > /quarantine/perfetto-v57.2-all-objects.txt
git -C /quarantine/perfetto-v57.2-verify.git \
  rev-list --objects refs/tags/v57.2 \
  | awk '{print $1}' | LC_ALL=C sort -u \
  > /quarantine/perfetto-v57.2-reachable-objects.txt
cmp /quarantine/perfetto-v57.2-all-objects.txt \
  /quarantine/perfetto-v57.2-reachable-objects.txt

git -C /quarantine/perfetto-v57.2-verify.git bundle create \
  /quarantine/perfetto-v57.2-sanitized.bundle refs/tags/v57.2
git bundle list-heads /quarantine/perfetto-v57.2-sanitized.bundle

git init --bare /srv/git/vendor/perfetto-public.git
git -C /srv/git/vendor/perfetto-public.git fetch --no-tags \
  /quarantine/perfetto-v57.2-sanitized.bundle \
  refs/tags/v57.2:refs/tags/v57.2
```

`cmp`가 한 바이트라도 다르면 중단한다. sanitized bundle의 head도 정확히
`24bdfb9… refs/tags/v57.2` 한 줄이어야 한다. 검역 임시 repo/목록/원본 bundle의
보존·폐기는 사내 evidence retention 정책으로 처리하며 company checkout 아래로
옮기지 않는다.

회사 저장소에 public commit object를 읽기 전용 vendor ref로 추가할 때:

```bash
git -C /work/company-perfetto fetch --no-tags \
  /srv/git/vendor/perfetto-public.git \
  refs/tags/v57.2:refs/vendor/google/perfetto-v57.2
```

회사 branch/tag는 바꾸지 않는다.

## 7. company Perfetto ancestry/diff 진단

```bash
COMPANY_PERFETTO_SHA=$(git -C /work/company-perfetto rev-parse HEAD)
printf '%s\n' "$COMPANY_PERFETTO_SHA"

/work/vendor-relu-ai-bridge/scripts/perfetto/diagnose-company.sh \
  /work/company-perfetto \
  /work/company-perfetto-integration/compat-results/diagnosis.txt
```

진단기는 네트워크 fetch를 하지 않고 public commit object가 이미 있는지 요구한다.

- `direct-descendant`: public v57.2가 company HEAD의 조상이다.
- `not-direct-descendant`: rebase/cherry-pick/독립 fork일 수 있다.
- 민감 diff: public plugin API, plugin manager/discovery, default plugin 목록,
  Vite/build 경로 변경을 보여 준다.

두 ancestry 결과 모두 자동 호환 판정이 아니다. 결과 파일에는 회사 SHA와 경로가
들어가므로 company integration 저장소 밖으로 내보내지 않는다.

## 8. generic Connector #1 overlay

회사 Perfetto는 저장소 최상위 경로를 정확히 지정하고 통합 전 허용 범위 밖
변경이 없어야 한다.

```bash
/work/vendor-relu-ai-bridge/scripts/perfetto/integrate.sh \
  --target company \
  --expected-head "$COMPANY_PERFETTO_SHA" \
  --mode copy \
  /work/company-perfetto
```

배치 계약:

```text
plugin/io.company.RELUPerfettoBridge
  → ui/src/plugins/io.company.RELUPerfettoBridge

perfetto_adapter
  → ui/src/perfetto_adapter
```

그리고 `ui/src/core/embedder/default_plugins.ts`에
`io.company.RELUPerfettoBridge`를 정확히 한 번 추가한다. 공개 patch context가 회사
fork와 다르면 중단한다. 진단 diff를 승인했고 anchor가 여전히 의미상 같은 경우에
한해 다음 fallback을 명시한다.

```bash
/work/vendor-relu-ai-bridge/scripts/perfetto/integrate.sh \
  --target company \
  --expected-head "$COMPANY_PERFETTO_SHA" \
  --mode copy \
  --allow-anchor-fallback \
  /work/company-perfetto
```

도구는 target path의 symlink 구성요소, 비관리 overlay, 예상 밖 dirty path를
거부한다. copy source의 ignored 파일도 재현 불가능한 입력으로 보고 거부한다.
회사 checkout의 Git dir/common dir가 외부 RELU checkout 안에 있거나 그 상위
tree인 linked worktree도 거부한다. enable patch는
`ui/src/core/embedder/default_plugins.ts`에 정확히 한 줄을 추가하는 단일 파일
patch인지 먼저 검사하므로 rollback 허용 범위 밖 hunk를 적용하지 않는다.
plugin·adapter·default plugin 변경을 한 transaction으로 취급하며
실패 시 이전 상태를 복구한다. 성공한 이전 내용은 회사 Perfetto
`.git/relu-ai-bridge-backups`에 남는다. `--refresh`는 새 승인 release로 이미
관리되는 overlay를 갱신할 때만 사용한다.

## 9. company-only adapter 격리

회사 API 차이가 없으면 이 단계는 생략한다. 차이가 있으면 외부 generic
`perfetto_adapter/v57`를 수정하지 않고 완전한 교체본을 사내 integration
저장소에 둔다.

`COMPANY_ADAPTER.json`:

```json
{
  "schema_version": 1,
  "company_perfetto_commit": "사내에서_확인한_정확한_40자리_SHA",
  "base_adapter": "v57"
}
```

적용:

```bash
/work/vendor-relu-ai-bridge/scripts/perfetto/overlay-company-adapter.sh \
  "$COMPANY_ADAPTER_DIR" \
  /work/company-perfetto \
  "$COMPANY_PERFETTO_SHA"
```

`COMPANY_ADAPTER_DIR`은 사내 configuration에서 정한 target label의 adapter
디렉터리다. 도구는 source와 target을 canonical realpath로 비교한다. 두 경로 모두
외부 RELU checkout 밖이어야 하고 서로 같거나 조상/자손으로 중첩될 수 없다.
company Perfetto의 Git dir/common dir도 외부 RELU checkout과 중첩될 수 없다. source의
symlink, `.git`, `node_modules`, env, trace, key를 거부하고 manifest SHA와 실제
company HEAD가 일치해야 한다. 교체는 인접 stage와 rename/rollback trap을 사용해
실패 시 generic adapter를 복원한다. backup에는 회사 코드가 포함될 수 있으므로
접근권한·보존기간·폐기 정책을 적용한다.

## 10. 사내 CI와 승격 게이트

최소 명령:

```bash
/work/vendor-relu-ai-bridge/scripts/perfetto/build-test.sh \
  --typecheck /work/company-perfetto
/work/vendor-relu-ai-bridge/scripts/perfetto/build-test.sh \
  --unit-tests /work/company-perfetto
/work/vendor-relu-ai-bridge/scripts/perfetto/build-test.sh \
  --build /work/company-perfetto
```

필수 CI 게이트:

1. RELU raw tag object, release commit, core/connector contract blob 확인
2. company Perfetto exact SHA와 company adapter manifest 확인
3. ancestry 및 plugin/API/build diff 승인
4. overlay 구조, TypeScript, connector unit test, production build
5. synthetic REF/DUT 정렬 회귀 테스트
6. 승인된 실제 trace의 end-to-end 테스트(결과는 사내 artifact storage만 사용)
7. loopback-only bridge, origin/token, 승인 scope, revocation 보안 테스트
8. dependency/license 및 build artifact digest 검토

재현 입력은 다음 네 요소로 기록한다.

```text
(RELU release commit, company Perfetto commit,
 company adapter commit 또는 not-used, build configuration digest)
```

`--install-deps`는 Perfetto 공식 dependency installer를 실행하므로 외부 인터넷이
아닌 승인 package mirror, lockfile, egress 정책을 확인한 격리 worker에서만 쓴다.

## 11. 배포, 롤백, 재동기화

배포 레코드에는 RELU tag/raw tag/commit, inbound bundle SHA-256, company Perfetto
SHA, company adapter revision, CI run, build artifact SHA-256, 승인자·시각을 남긴다.

롤백은 immutable ref나 integration history를 rewrite하는 작업이 아니다. 이전에
검증한 네 입력 조합의 artifact로 배포 포인터를 되돌린다. 가능하면 backup을
수동 복사하지 말고 이전 vendor tag와 company integration commit으로 새
disposable Perfetto worktree를 만들어 재빌드한다.

새 RELU release가 도착하면:

1. 새 quarantine 디렉터리에서 독립 검증한다.
2. immutable mirror에 새 tag/ref를 추가한다.
3. 새 detached vendor checkout을 만든다.
4. 동일한 company SHA에서 진단과 generic copy overlay를 다시 수행한다.
5. 필요하면 release별 company adapter branch를 갱신한다.
6. 전체 CI와 실제 trace 승인을 통과한다.
7. 배포 포인터만 새 입력 조합으로 변경한다.

실패하면 기존 checkout, immutable refs, build artifact를 그대로 유지해 이전
조합으로 즉시 복귀한다.

## 12. 사내 정보 유출 방지 체크리스트

외부 방향 작업은 별도 보안 담당자가 모두 확인할 때까지 중단한다.

- [ ] 외부 checkout과 CI에 사내 remote/credential/egress route가 없다.
- [ ] company Perfetto와 integration 저장소가 외부 RELU tree 내부에 중첩되지 않았다.
- [ ] company Perfetto의 Git dir/common dir도 외부 RELU tree와 중첩되지 않았다.
- [ ] external reachable history에 실제 trace나 회사 파일이 한 번도 없었다.
- [ ] source/history/tag/dependency inventory를 수동 검토했다.
- [ ] 회사 adapter, 내부 patch, host/IP/URL/경로/계정/제품명이 없다.
- [ ] 외부 compatibility/release manifest에 회사 target label·SHA·상태가 없다.
- [ ] author/committer/tagger/message/signature header에 사내 식별 정보가 없다.
- [ ] log, screenshot, SQL output, prompt/response, browser profile이 없다.
- [ ] test fixture는 원본과 독립 생성한 synthetic data다.
- [ ] binary 포함 reachable blob/metadata scanner와 수동 diff를 모두 통과했다.
- [ ] 반출 승인 기록에는 object ID/checksum만 있고 민감 본문이 없다.

사내 문제를 외부에서 재현할 때 원본 trace를 단순 익명화·축소해 반출하지 않는다.
원본과 독립적으로 synthetic trace/test를 작성하고 별도 outbound review를 통과한
자료만 외부 generic connector 개선에 사용한다.
