# RELU AI Bridge Connector #1: Perfetto 소스 통합 계층

Perfetto UI 플러그인은 현재 소스 트리 내부에서 빌드해야 한다. 이 디렉터리는
RELU AI Bridge의 Connector #1 소스를 Perfetto checkout에 복사하거나 연결하고, 플러그인을 기본
활성화하는 최소 패치만 소유한다.

- RELU core / Perfetto connector release: `0.5.0`
- adapter contract: `v57`

- 공개 기준선: Perfetto `v57.2`, commit
  `da1d152cff27890903d158fe96751de3aab883cc`
- 플러그인: `plugin/io.company.RELUPerfettoBridge`
- 공유 protocol 및 v57 adapter: `perfetto_adapter`
- Perfetto 내 목적지:
  `ui/src/plugins/io.company.RELUPerfettoBridge`, `ui/src/perfetto_adapter`
- 기본 활성화 패치:
  `patches/perfetto-v57.2-enable-default-plugin.patch`

공개 기준선 로컬 개발 시에는 `integrate.sh --mode symlink`, 재현 가능한 빌드와
사내 반입에는 `--mode copy`를 사용한다. company 대상은 symlink 및 dirty RELU
source를 거부한다. 스크립트는 기존 비관리 플러그인 디렉터리를
덮어쓰지 않고 중단한다. 자세한 명령은
[`docs/INTERNAL_SYNC_KO.md`](../docs/INTERNAL_SYNC_KO.md)를 따른다.
