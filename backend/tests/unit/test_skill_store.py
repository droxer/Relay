from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from relay.core.ids import now_iso
from relay.persistence.skill_store import (
    MAX_FILE_BYTES,
    MAX_FILES,
    DatabaseSkillStore,
    SkillValidationError,
)
from relay.persistence.skill_object_store import LocalSkillObjectStore
from relay.persistence.store_common import _parse_iso
from sqlalchemy import func, insert, select


def _store(tmp_path) -> tuple[DatabaseSkillStore, str, str]:
    store = DatabaseSkillStore(
        f"sqlite:///{tmp_path}/relay.db",
        create_schema=True,
        object_store=LocalSkillObjectStore(tmp_path / "skill-objects"),
    )
    alice, bob = str(uuid4()), str(uuid4())
    with store.engine.begin() as conn:
        for employee_id, handle in ((alice, "alice"), (bob, "bob")):
            conn.execute(
                insert(store.employees).values(
                    id=employee_id,
                    handle=handle,
                    display_name=handle.title(),
                    email=None,
                    department_id=None,
                    max_local_computers=None,
                    created_at=_parse_iso(now_iso()),
                    updated_at=_parse_iso(now_iso()),
                    deleted_at=None,
                )
            )
    return store, alice, bob


def _files(name="review", description="Reviews code", body=b"Body", extra=()):
    manifest = f"---\nname: {name}\ndescription: {description}\n---\n".encode() + body
    return [{"path": "SKILL.md", "content": manifest}, *extra]


def _create(store, owner, name="review", **overrides):
    return store.create_skill(
        owner,
        {
            "name": name,
            "visibility": "private",
            "source": "authored",
            "files": _files(name=name),
            **overrides,
        },
    )


def test_create_skill_is_event_authoritative_and_makes_revision(tmp_path):
    store, alice, _ = _store(tmp_path)
    skill = _create(store, alice)
    assert skill["slug"] == "review"
    assert skill["description"] == "Reviews code"
    assert store.get_revision(skill["currentRevisionId"])["revision"] == 1
    assert [event["type"] for event in store.events(skill["id"])] == [
        "skill.created",
        "skill.revision.added",
    ]
    # Corrupt the disposable projection; reads replay authoritative history.
    with store.engine.begin() as conn:
        conn.execute(
            store.skills.update()
            .where(store.skills.c.id == skill["id"])
            .values(snapshot={"bad": True})
        )
    assert store.get_skill(skill["id"])["name"] == "review"


def test_frontmatter_supports_yaml_folded_description_and_metadata(tmp_path):
    store, alice, _ = _store(tmp_path)
    content = b'---\nname: review\ndescription: >-\n  Reviews code\n  carefully.\nmetadata:\n  tags: [review, code]\n---\nBody'
    skill = _create(store, alice, files=[{"path": "SKILL.md", "content": content}])
    assert skill["description"] == "Reviews code carefully."


@pytest.mark.parametrize("field", ["source", "visibility"])
def test_non_scalar_enum_rejected_as_validation_error(tmp_path, field):
    store, alice, _ = _store(tmp_path)
    with pytest.raises(SkillValidationError):
        _create(store, alice, **{field: {"bad": "value"}})


def test_revisions_are_immutable_incrementing_and_listed(tmp_path):
    store, alice, _ = _store(tmp_path)
    skill = _create(store, alice)
    first = skill["currentRevisionId"]
    updated = store.add_revision(skill["id"], alice, _files(body=b"New"), note="v2")
    assert [r["revision"] for r in store.list_revisions(skill["id"])] == [2, 1]
    assert store.get_revision(updated["currentRevisionId"])["revision"] == 2
    first_file = store.revision_files(first)[0]
    assert "content" not in first_file
    assert store.blob(first_file["sha256"]).endswith(b"Body")


def test_manifest_order_independent_and_blob_deduplicated(tmp_path):
    store, alice, _ = _store(tmp_path)
    extra = [{"path": "refs/a.md", "content": b"same"}]
    a = _create(store, alice, "a", files=_files("a", extra=extra))
    reordered = store.add_revision(
        a["id"], alice, list(reversed(_files("a", extra=extra)))
    )
    b = _create(store, alice, "b", files=list(reversed(_files("b", extra=extra))))
    # Shared supporting content occupies one CAS row.
    with store.engine.begin() as conn:
        assert (
            conn.scalar(
                select(func.count())
                .select_from(store.blobs)
                    .where(store.blobs.c.sha256 == hashlib.sha256(b"same").hexdigest())
            )
            == 1
        )
        assert conn.scalar(select(store.blobs.c.content).limit(1)) is None
    assert (
        store.blob(store.revision_files(a["currentRevisionId"])[1]["sha256"]) == b"same"
    )
    assert store.get_revision(a["currentRevisionId"])[
        "manifestSha256"
    ] == store.get_revision(reordered["currentRevisionId"])["manifestSha256"]
    assert (
        store.get_revision(a["currentRevisionId"])["manifestSha256"]
        != store.get_revision(b["currentRevisionId"])["manifestSha256"]
    )


def test_live_name_uniqueness_normalizes_absent_namespace(tmp_path):
    store, alice, _ = _store(tmp_path)
    _create(store, alice)
    with pytest.raises(SkillValidationError) as exc:
        _create(store, alice, namespace=None)
    assert exc.value.code == "skill-name-taken"


def test_visibility_soft_delete_and_live_uniqueness(tmp_path):
    store, alice, bob = _store(tmp_path)
    mine = _create(store, alice, "mine")
    _create(store, bob, "secret")
    shared = _create(store, bob, "shared", visibility="org", ownerHandle="bob")
    assert {s["id"] for s in store.list_skills(alice)} == {mine["id"], shared["id"]}
    deleted = store.delete_skill(mine["id"])
    assert deleted["deletedAt"] and store.get_skill(mine["id"])["deletedAt"]
    assert _create(store, alice, "mine")["slug"] == "mine"


def test_slug_allocation_prevents_exact_and_prefix_conflicts(tmp_path):
    store, alice, bob = _store(tmp_path)
    _create(store, alice, "review", namespace="tools", visibility="org")
    second = _create(store, bob, "tools", visibility="org", ownerHandle="bob")
    third = _create(
        store, bob, "review", namespace="tools", visibility="org", ownerHandle="bob"
    )
    assert second["slug"] == "tools-bob"
    assert third["slug"] == "tools/review-bob"


@pytest.mark.parametrize(
    "name,namespace",
    [
        ("../escape", None),
        ("a/b", None),
        ("Good Name", None),
        ("review", "../x"),
        ("review", "/root"),
        ("review", "a//b"),
        ("review", "/".join(["n" * 64] * 8)),
    ],
)
def test_rejects_unsafe_identity_parts(tmp_path, name, namespace):
    store, alice, _ = _store(tmp_path)
    with pytest.raises(SkillValidationError) as exc:
        _create(store, alice, name, namespace=namespace, files=_files(name=name))
    assert exc.value.code in {"invalid-name", "invalid-namespace"}


@pytest.mark.parametrize(
    "files,code",
    [
        (
            [{"path": "SKILL.md", "content": b"x" * (MAX_FILE_BYTES + 1)}],
            "file-too-large",
        ),
        (
            [{"path": "SKILL.md", "content": b"---\nname: n\ndescription: d\n---\n"}]
            + [{"path": f"r/{i}", "content": b""} for i in range(MAX_FILES)],
            "too-many-files",
        ),
        (_files("n", extra=[{"path": "../escape", "content": b"x"}]), "invalid-path"),
        (_files("n", extra=[{"path": "/abs", "content": b"x"}]), "invalid-path"),
        (_files("n", extra=[{"path": "p" * 256, "content": b"x"}]), "invalid-path"),
        (_files("n", extra=[{"path": "/".join(["p" * 200] * 3), "content": b"x"}]), "invalid-path"),
        (
            _files(
                "n",
                extra=[
                    {"path": "dup", "content": b"x"},
                    {"path": "dup", "content": b"y"},
                ],
            ),
            "duplicate-path",
        ),
        (
            _files(
                "n",
                extra=[
                    {"path": "refs", "content": b"x"},
                    {"path": "refs/a", "content": b"y"},
                ],
            ),
            "path-conflict",
        ),
        (
            _files(
                "n",
                extra=[
                    {"path": f"part-{i}", "content": b"x" * MAX_FILE_BYTES}
                    for i in range(4)
                ],
            ),
            "revision-too-large",
        ),
    ],
)
def test_bundle_limits_and_paths(tmp_path, files, code):
    store, alice, _ = _store(tmp_path)
    with pytest.raises(SkillValidationError) as exc:
        _create(store, alice, "n", files=files)
    assert exc.value.code == code


@pytest.mark.parametrize(
    "body,code",
    [
        (b"plain", "invalid-skill-md"),
        (b"---\nname: n\n---\n", "skill-description-required"),
        (b"---\nname: other\ndescription: d\n---\n", "skill-name-mismatch"),
        (b"---\nname: n\ndescription:\n---\n", "skill-description-required"),
    ],
)
def test_skill_md_frontmatter_is_validated(tmp_path, body, code):
    store, alice, _ = _store(tmp_path)
    with pytest.raises(SkillValidationError) as exc:
        _create(store, alice, "n", files=[{"path": "SKILL.md", "content": body}])
    assert exc.value.code == code


def test_concurrent_revisions_get_distinct_monotonic_numbers(tmp_path):
    store, alice, _ = _store(tmp_path)
    skill = _create(store, alice)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda i: store.add_revision(
                    skill["id"], alice, _files(body=str(i).encode())
                ),
                range(2),
            )
        )
    numbers = {store.get_revision(r["currentRevisionId"])["revision"] for r in results}
    assert numbers == {2, 3}


def test_stable_revision_is_explicitly_promoted(tmp_path):
    store, alice, _ = _store(tmp_path)
    skill = _create(store, alice)
    first = skill["currentRevisionId"]

    updated = store.add_revision(skill["id"], alice, _files(body=b"New"))
    assert updated["currentRevisionId"] != first
    assert updated["stableRevisionId"] == first

    promoted = store.promote_revision(skill["id"], updated["currentRevisionId"])
    assert promoted["stableRevisionId"] == updated["currentRevisionId"]
    assert store.events(skill["id"])[-1]["type"] == "skill.revision.promoted"


def test_cannot_promote_revision_from_another_skill(tmp_path):
    store, alice, _ = _store(tmp_path)
    first = _create(store, alice, "first")
    second = _create(store, alice, "second")

    with pytest.raises(SkillValidationError) as exc:
        store.promote_revision(first["id"], second["currentRevisionId"])
    assert exc.value.code == "revision-not-found"
