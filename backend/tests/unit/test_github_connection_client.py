import httpx
import pytest

from relay.accounts import github_client


@pytest.mark.parametrize("permissions", [
    {"issues": "write", "metadata": "read"},
    {"issues": "read", "metadata": "read", "contents": "read"},
    {"metadata": "read"},
])
def test_connection_refuses_permissions_beyond_read_only_issues(monkeypatch, permissions):
    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(lambda request:
        httpx.Response(200, json={"installations": [{"id": 7, "permissions": permissions}]})))
    with pytest.raises(github_client.GitHubConnectionError, match="github_connection_permissions_invalid"):
        github_client.verify_installation("token", 7)


def test_connection_checks_the_exact_installation_returned_by_the_callback(monkeypatch):
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json={"installations": [{"id": 7, "permissions": {"issues": "read"}}]})

    monkeypatch.setattr(github_client, "transport", httpx.MockTransport(handler))
    with pytest.raises(github_client.GitHubConnectionError, match="github_connection_rejected"):
        github_client.verify_installation("token", 999)
    assert paths == ["/user/installations"]
