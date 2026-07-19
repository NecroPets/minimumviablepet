"""Direct HTTP tests of the waitlist API. Every assertion about stored data is
made against the actual SQLite file, never the API's own response."""
import datetime
import http.client
import json
import urllib.request

import pytest


def test_health(server):
    with urllib.request.urlopen(server.base_url + "/api/health", timeout=2) as r:
        assert r.status == 200
        assert json.loads(r.read()) == {"ok": True}


def test_valid_signup_variant_a(server, db_rows, waitlist_post):
    status, body, _ = waitlist_post(server.base_url, {"email": "a@example.com", "variant": "necropets"})
    assert status == 201
    assert body == {"ok": True, "email": "a@example.com", "variant": "necropets"}

    rows = db_rows(server.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["email"] == "a@example.com"
    assert row["variant"] == "necropets"
    assert row["user_agent"]  # urllib always sends one
    # created_at must be ISO-8601 UTC, parseable
    parsed = datetime.datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
    assert parsed.tzinfo is not None


def test_valid_signup_variant_b(server, db_rows, waitlist_post):
    status, _, _ = waitlist_post(server.base_url, {"email": "b@example.com", "variant": "minimumviablepet"})
    assert status == 201
    rows = db_rows(server.db_path)
    assert [r["variant"] for r in rows] == ["minimumviablepet"]


def test_same_email_both_variants_is_two_conversions(server, db_rows, waitlist_post):
    s1, _, _ = waitlist_post(server.base_url, {"email": "both@example.com", "variant": "necropets"})
    s2, _, _ = waitlist_post(server.base_url, {"email": "both@example.com", "variant": "minimumviablepet"})
    assert (s1, s2) == (201, 201)
    rows = db_rows(server.db_path)
    assert len(rows) == 2
    assert {r["variant"] for r in rows} == {"necropets", "minimumviablepet"}


def test_duplicate_is_409_and_not_stored_twice(server, db_rows, waitlist_post):
    s1, _, _ = waitlist_post(server.base_url, {"email": "dup@example.com", "variant": "necropets"})
    s2, body, _ = waitlist_post(server.base_url, {"email": "dup@example.com", "variant": "necropets"})
    assert s1 == 201
    assert s2 == 409
    assert body == {"ok": False, "error": "duplicate"}
    assert len(db_rows(server.db_path)) == 1


def test_email_normalization(server, db_rows, waitlist_post):
    status, body, _ = waitlist_post(server.base_url, {"email": "  Foo@Bar.COM ", "variant": "necropets"})
    assert status == 201
    assert body["email"] == "foo@bar.com"
    assert db_rows(server.db_path)[0]["email"] == "foo@bar.com"

    # normalized form collides with the stored row
    status2, body2, _ = waitlist_post(server.base_url, {"email": "foo@bar.com", "variant": "necropets"})
    assert status2 == 409
    assert body2["error"] == "duplicate"
    assert len(db_rows(server.db_path)) == 1


@pytest.mark.parametrize(
    "email",
    ["", "no-at", "a@b", "a b@c.com", "a@b.", "@b.com", "a@.com", "a" * 300 + "@x.com"],
)
def test_invalid_emails_rejected(server, db_rows, waitlist_post, email):
    status, body, _ = waitlist_post(server.base_url, {"email": email, "variant": "necropets"})
    assert status == 400
    assert body == {"ok": False, "error": "invalid_email"}
    assert db_rows(server.db_path) == []


@pytest.mark.parametrize("payload", [{"email": "x@y.com"}, {"email": "x@y.com", "variant": "other"}])
def test_invalid_variant_rejected(server, db_rows, waitlist_post, payload):
    status, body, _ = waitlist_post(server.base_url, payload)
    assert status == 400
    assert body == {"ok": False, "error": "invalid_variant"}
    assert db_rows(server.db_path) == []


def test_malformed_json_rejected(server, db_rows, waitlist_post):
    status, body, _ = waitlist_post(server.base_url, b"not json")
    assert status == 400
    assert body == {"ok": False, "error": "invalid_json"}
    assert db_rows(server.db_path) == []


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
def test_wrong_method_on_waitlist(server, method):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    conn.request(method, "/api/waitlist")
    resp = conn.getresponse()
    body = json.loads(resp.read())
    conn.close()
    assert resp.status == 405
    assert resp.getheader("Allow") == "POST"
    assert body == {"ok": False, "error": "method_not_allowed"}


def test_oversized_payload_rejected(server, db_rows, waitlist_post):
    padded = {"email": "x@y.com", "variant": "necropets", "pad": "a" * 8000}
    status, body, _ = waitlist_post(server.base_url, padded)
    assert status == 413
    assert body == {"ok": False, "error": "payload_too_large"}
    assert db_rows(server.db_path) == []


def test_routing(server):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)

    conn.request("GET", "/")
    resp = conn.getresponse()
    resp.read()
    assert resp.status == 302
    assert resp.getheader("Location") == "/minimumviablepet/"

    conn.request("GET", "/necropets")
    resp = conn.getresponse()
    resp.read()
    assert resp.status == 301
    assert resp.getheader("Location") == "/necropets/"

    conn.request("GET", "/minimumviablepet")
    resp = conn.getresponse()
    resp.read()
    assert resp.status == 301
    assert resp.getheader("Location") == "/minimumviablepet/"

    for path in ("/necropets/", "/minimumviablepet/"):
        conn.request("GET", path)
        resp = conn.getresponse()
        html = resp.read()
        assert resp.status == 200
        assert resp.getheader("Cache-Control") == "no-store"
        assert b"<!doctype html>" in html.lower()

    conn.request("GET", "/nope")
    resp = conn.getresponse()
    body = json.loads(resp.read())
    conn.close()
    assert resp.status == 404
    assert body == {"ok": False, "error": "not_found"}
