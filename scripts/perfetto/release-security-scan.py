#!/usr/bin/env python3
"""RELU release tag의 도달 가능한 모든 Git 객체를 fail-closed로 검역한다."""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys


FORBIDDEN_PATH = re.compile(
    rb"(?:^|/)(?:"
    rb"\.git(?:/|$)|node_modules(?:/|$)|\.env(?:$|[./])|"
    rb"id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|"
    rb"credentials\.json$|secrets?\.json$|"
    rb"[^/]+\.(?:pftrace|perfetto-trace|trace|pem|p12|pfx|key)$"
    rb")",
    re.IGNORECASE,
)

SECRET = re.compile(
    rb"(?:"
    rb"-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|"
    rb"-----BEGIN PGP PRIVATE KEY "
    rb"BLOCK-----|"
    rb"AKIA[0-9A-Z]{16}|"
    rb"gh[pousr]_[A-Za-z0-9]{30,}|"
    rb"github_pat_[A-Za-z0-9_]{20,}|"
    rb"xox[baprs]-[A-Za-z0-9-]{10,}"
    rb")"
)

MAX_BLOB_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BLOB_BYTES = 1024 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_COMMITS = 10_000
MAX_TREE_ENTRIES = 5_000_000


class ScanError(RuntimeError):
    pass


def git(repository: pathlib.Path, *arguments: str) -> bytes:
    try:
        completed = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        detail = (
            error.stderr.decode("utf-8", "replace")
            .strip()
            .encode("unicode_escape")
            .decode("ascii")
        )
        raise ScanError(f"git {' '.join(arguments)} 실패: {detail}") from error
    return completed.stdout


def scan(repository: pathlib.Path, reference: str) -> tuple[int, int]:
    object_type = git(repository, "cat-file", "-t", reference).strip()
    if object_type != b"tag":
        raise ScanError("release ref는 annotated tag object여야 합니다")

    tag_object = git(repository, "rev-parse", reference).strip().decode("ascii")
    tag_header = git(repository, "cat-file", "tag", tag_object).split(b"\n\n", 1)[0]
    if b"\ntype commit\n" not in b"\n" + tag_header + b"\n":
        raise ScanError("release annotated tag는 commit을 직접 가리켜야 합니다")
    commits = [
        line.decode("ascii")
        for line in git(repository, "rev-list", f"{reference}^{{}}").splitlines()
        if line
    ]
    if not commits:
        raise ScanError("release tag에서 도달 가능한 commit이 없습니다")
    if len(commits) > MAX_COMMITS:
        raise ScanError(f"reachable commit 수 상한 초과: {len(commits)}")

    blob_paths: dict[str, bytes] = {}
    tree_entries = 0
    for commit in commits:
        tree = git(repository, "ls-tree", "-r", "-z", "--full-tree", commit)
        for record in tree.split(b"\0"):
            if not record:
                continue
            try:
                metadata, path = record.split(b"\t", 1)
                mode, object_kind, object_id = metadata.split(b" ", 2)
            except ValueError as error:
                raise ScanError(f"ls-tree 출력 파싱 실패: {commit}") from error
            tree_entries += 1
            if tree_entries > MAX_TREE_ENTRIES:
                raise ScanError(f"reachable tree entry 누적 상한 초과: {tree_entries}")
            if FORBIDDEN_PATH.search(path):
                printable = repr(path)
                raise ScanError(f"금지 경로 발견: {commit} {printable}")
            if mode == b"120000":
                printable = repr(path)
                raise ScanError(f"symlink 발견: {commit} {printable}")
            if mode == b"160000" or object_kind == b"commit":
                printable = repr(path)
                raise ScanError(f"gitlink/submodule 발견: {commit} {printable}")
            if object_kind == b"blob":
                blob_paths.setdefault(object_id.decode("ascii"), path)

    metadata_objects = [("tag", tag_object), *[("commit", item) for item in commits]]
    for kind, object_id in metadata_objects:
        size = int(git(repository, "cat-file", "-s", object_id))
        if size > MAX_METADATA_BYTES:
            raise ScanError(f"비정상적으로 큰 {kind} metadata: {object_id} bytes={size}")
        raw = git(repository, "cat-file", kind, object_id)
        if SECRET.search(raw):
            raise ScanError(f"credential 형태가 {kind} metadata에 있습니다: {object_id}")

    total_blob_bytes = 0
    for object_id, path in blob_paths.items():
        size = int(git(repository, "cat-file", "-s", object_id))
        if size > MAX_BLOB_BYTES:
            printable = repr(path)
            raise ScanError(f"blob 크기 상한 초과: {object_id} {printable} bytes={size}")
        total_blob_bytes += size
        if total_blob_bytes > MAX_TOTAL_BLOB_BYTES:
            raise ScanError(
                f"도달 가능한 unique blob 총 크기 상한 초과: bytes={total_blob_bytes}"
            )
        raw = git(repository, "cat-file", "blob", object_id)
        if SECRET.search(raw):
            printable = repr(path)
            raise ScanError(f"credential 형태가 blob에 있습니다: {object_id} {printable}")

    return len(commits), len(blob_paths)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=pathlib.Path)
    parser.add_argument("--ref", required=True)
    arguments = parser.parse_args()
    try:
        commits, blobs = scan(arguments.repository, arguments.ref)
    except (OSError, ScanError) as error:
        print(f"오류: release 보안 검역 실패: {error}", file=sys.stderr)
        return 1
    print(f"release 보안 검역 통과: commits={commits}, unique_blobs={blobs}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
