from __future__ import annotations

import pytest
from relay.persistence.org_settings_store import (
    DatabaseOrgSettingsStore,
    OrgSettingsValidationError,
)


def test_import_allowlist_defaults_persists_and_preserves_other_settings(tmp_path):
    url = f"sqlite:///{tmp_path}/settings.db"
    store = DatabaseOrgSettingsStore(url, create_schema=True)
    assert store.get_settings()["skillImportAllowedHosts"] == ["github.com"]
    store.update_settings(skill_import_allowed_hosts=[])
    assert DatabaseOrgSettingsStore(url).get_settings()["skillImportAllowedHosts"] == []
    store.update_settings(max_task_rounds=8)
    assert store.get_settings()["skillImportAllowedHosts"] == []
    store.update_settings(skill_import_allowed_hosts=["GITHUB.COM", "github.com"])
    assert store.get_settings()["skillImportAllowedHosts"] == ["github.com"]
    assert store.get_settings()["maxTaskRounds"] == 8


@pytest.mark.parametrize("hosts", ["github.com", ["https://github.com"], ["*.github.com"], ["127.0.0.1"], ["localhost"], [None]])
def test_import_allowlist_requires_exact_dns_hostnames(tmp_path, hosts):
    store = DatabaseOrgSettingsStore(f"sqlite:///{tmp_path}/settings.db", create_schema=True)
    with pytest.raises(OrgSettingsValidationError):
        store.update_settings(skill_import_allowed_hosts=hosts)
