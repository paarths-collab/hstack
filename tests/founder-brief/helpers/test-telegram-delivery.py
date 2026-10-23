"""Real loopback HTTP, synthetic credentials; never contacts Telegram/GitHub."""
import concurrent.futures
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("telegram_delivery", ROOT / "packages/founder-brief/telegram_delivery.py")
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)
TOKEN = "123456:" + "FAKE" + "x" * 32
GITHUB = "ghp_" + "FAKE" * 8
CHAT = 555000111
NOW = 1792764000
IDENTITY = dict(run_id="brief-2026-10-23", config_hash="c" * 64, window_id="2026-10-23", body="GitHub daily brief\n1 merged pull request.", chat_id=CHAT)


class Server:
    def __init__(self):
        self.calls, self.mode, self.sends = [], "ok", 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                method = self.path.rsplit("/", 1)[-1]
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append((method, payload))
                status, result = 200, {"ok": True}
                if method == "getMe":
                    result["result"] = {"id": 987654 if owner.mode == "bot-mismatch" else 123456, "is_bot": True}
                elif method == "getChat":
                    result["result"] = {"id": CHAT + 1 if owner.mode == "chat-mismatch" else CHAT,
                                        "type": "supergroup" if owner.mode == "group" else "private"}
                elif method == "sendMessage":
                    owner.sends += 1
                    result["result"] = {"message_id": owner.sends, "date": NOW,
                                        "from": {"id": 123456, "is_bot": True},
                                        "chat": {"id": CHAT, "type": "private"}, "text": payload["text"]}
                    if owner.mode in {"500", "403", "429", "429-long", "429-always"}:
                        status = int(owner.mode.split("-")[0])
                        if owner.mode == "429" and owner.sends > 1:
                            status = 200
                        else:
                            result = {"ok": False, "error_code": status, "description": TOKEN + GITHUB,
                                      "parameters": {"retry_after": 10 if owner.mode == "429-long" else 0}}
                    if owner.mode == "wrong-chat":
                        result["result"]["chat"]["id"] += 1
                    if owner.mode == "wrong-type":
                        result["result"]["chat"]["type"] = "group"
                    if owner.mode == "wrong-body":
                        result["result"]["text"] += " unexpected"
                    if owner.mode == "wrong-bot":
                        result["result"]["from"]["id"] += 1
                    if owner.mode == "stale":
                        result["result"]["date"] = NOW - 31
                    if owner.mode == "future":
                        result["result"]["date"] = NOW + 31
                    if owner.mode == "no-message-id":
                        result["result"].pop("message_id")
                    if owner.mode == "bool-id":
                        result["result"]["message_id"] = True
                    if owner.mode == "lost-response":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    if owner.mode == "redirect":
                        self.send_response(302)
                        self.send_header("Location", "https://example.invalid/" + TOKEN)
                        self.end_headers()
                        return
                raw = b"malformed" if owner.mode == "malformed" and method == "sendMessage" else json.dumps(result).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, payload):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request("POST", "/fake-bot/" + method, json.dumps(payload), {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, dict(response.headers), response.read()
        finally:
            connection.close()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = Server()

    @classmethod
    def tearDownClass(cls):
        cls.api.close()

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="hstack-tg-proof-")
        self.state = Path(self.scratch.name) / "private-state"
        self.api.mode, self.api.calls, self.api.sends = "ok", [], 0
        self.sleeps = []

    def tearDown(self):
        self.scratch.cleanup()

    def sender(self, **kw):
        return delivery.TelegramDelivery(str(self.state), TOKEN, GITHUB, _client=self.api.request,
                                         _now=lambda: NOW, _sleep=self.sleeps.append, **kw)

    def test_ack_is_bound_private_atomic_and_replayed_without_resend(self):
        sender = self.sender()
        self.assertIsNone(sender.lookup(config_hash=IDENTITY["config_hash"], window_id=IDENTITY["window_id"], chat_id=CHAT))
        proof = sender.deliver(**IDENTITY)
        self.assertEqual(sender.deliver(**IDENTITY), proof)
        self.assertEqual(sender.lookup(config_hash=IDENTITY["config_hash"], window_id=IDENTITY["window_id"], chat_id=CHAT), proof)
        self.assertEqual(self.api.sends, 1)
        self.assertEqual([call[0] for call in self.api.calls], ["getMe", "getChat", "sendMessage"])
        self.assertEqual(proof["evidence_scope"], "telegram-api-ack")
        self.assertEqual(proof["status"], "confirmed")
        self.assertFalse(proof["recipient_read"])
        self.assertEqual(proof["body_sha256"], hashlib.sha256(IDENTITY["body"].encode()).hexdigest())
        self.assertEqual(proof["window_id"], IDENTITY["window_id"])
        self.assertEqual(proof["run_id"], IDENTITY["run_id"])
        self.assertEqual(proof["config_hash"], IDENTITY["config_hash"])
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        for file in self.state.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            content = file.read_text()
            self.assertNotIn(TOKEN, content)
            self.assertNotIn(GITHUB, content)
            self.assertNotIn(str(CHAT), content)
        post = self.api.calls[-1][1]
        self.assertNotIn("parse_mode", post)
        self.assertTrue(post["disable_web_page_preview"])

    def test_credentials_are_rejected_before_any_post(self):
        for credential in (TOKEN, GITHUB):
            with self.subTest(credential="synthetic"):
                with self.assertRaisesRegex(delivery.DeliveryError, "telegram_body_contains_credential"):
                    self.sender().deliver(**{**IDENTITY, "body": "accidental " + credential})
        self.assertEqual(self.api.calls, [])

    def test_wrong_peer_private_type_and_negative_id_never_send(self):
        for mode in ("bot-mismatch", "chat-mismatch", "group"):
            self.api.mode = mode
            with self.subTest(mode=mode), self.assertRaises(delivery.DeliveryError):
                self.sender().deliver(**IDENTITY)
            self.assertEqual(self.api.sends, 0)
        for chat in ("-100111", 0, True, "01", 2**64):
            with self.subTest(chat="invalid"), self.assertRaises(delivery.DeliveryError):
                self.sender().deliver(**{**IDENTITY, "chat_id": chat})

    def test_wrong_body_chat_bot_id_date_or_malformed_ack_stays_unknown_and_no_resend(self):
        modes = ("wrong-chat", "wrong-type", "wrong-body", "wrong-bot", "stale", "future", "no-message-id", "bool-id", "malformed", "redirect")
        for n, mode in enumerate(modes):
            self.api.mode = mode
            identity = {**IDENTITY, "window_id": "window-" + str(n)}
            before = self.api.sends
            with self.subTest(mode=mode), self.assertRaises(delivery.DeliveryUnknown) as error:
                self.sender().deliver(**identity)
            self.assertNotIn(TOKEN, str(error.exception))
            self.assertNotIn(GITHUB, str(error.exception))
            self.api.mode = "ok"
            with self.assertRaisesRegex(delivery.DeliveryUnknown, "reconciliation_required"):
                self.sender().deliver(**identity)
            with self.assertRaisesRegex(delivery.DeliveryUnknown, "reconciliation_required"):
                self.sender().lookup(config_hash=identity["config_hash"], window_id=identity["window_id"], chat_id=CHAT)
            self.assertEqual(self.api.sends, before + 1)

    def test_server_error_and_lost_response_are_not_blindly_retried(self):
        for n, mode in enumerate(("500", "lost-response")):
            self.api.mode = mode
            identity = {**IDENTITY, "window_id": "error-" + str(n)}
            before = self.api.sends
            with self.assertRaises(delivery.DeliveryUnknown):
                self.sender().deliver(**identity)
            self.api.mode = "ok"
            with self.assertRaises(delivery.DeliveryUnknown):
                self.sender().deliver(**identity)
            self.assertEqual(self.api.sends, before + 1)

    def test_explicit_rejection_stays_rejected_without_resend_or_error_leak(self):
        self.api.mode = "403"
        with self.assertRaises(delivery.DeliveryError) as error:
            self.sender().deliver(**IDENTITY)
        self.assertNotIn(TOKEN, str(error.exception))
        self.assertNotIn(GITHUB, str(error.exception))
        self.api.mode = "ok"
        with self.assertRaisesRegex(delivery.DeliveryError, "telegram_delivery_rejected"):
            self.sender().deliver(**IDENTITY)
        self.assertEqual(self.api.sends, 1)

    def test_rate_limit_retry_is_bounded_and_only_explicit_429_is_retried(self):
        self.api.mode = "429"
        proof = self.sender().deliver(**IDENTITY)
        self.assertEqual(proof["message_id"], 2)
        self.assertEqual(self.sleeps, [0])
        self.assertEqual(self.api.sends, 2)
        self.api.mode = "429-always"
        with self.assertRaisesRegex(delivery.DeliveryError, "telegram_rate_limited"):
            self.sender().deliver(**{**IDENTITY, "window_id": "limited"})
        self.assertEqual(self.api.sends, 5)
        self.api.mode = "429-long"
        before = len(self.sleeps)
        with self.assertRaises(delivery.DeliveryError):
            self.sender().deliver(**{**IDENTITY, "window_id": "long-delay"})
        self.assertEqual(len(self.sleeps), before)

    def test_concurrent_same_window_dispatch_has_one_ack_and_one_send(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            proofs = list(pool.map(lambda _: self.sender().deliver(**IDENTITY), range(4)))
        self.assertTrue(all(proof == proofs[0] for proof in proofs))
        self.assertEqual(self.api.sends, 1)

    def test_changed_run_or_body_cannot_reuse_ack_or_send_same_window(self):
        self.sender().deliver(**IDENTITY)
        for change in ({"run_id": "different-run"}, {"body": "Different content."}):
            with self.assertRaisesRegex(delivery.DeliveryError, "delivery_identity_conflict"):
                self.sender().deliver(**{**IDENTITY, **change})
        self.assertEqual(self.api.sends, 1)
        other = delivery.TelegramDelivery(str(self.state), "987654:" + "FAKE" * 8, GITHUB,
                                          _client=self.api.request, _now=lambda: NOW)
        with self.assertRaisesRegex(delivery.DeliveryError, "delivery_identity_conflict"):
            other.deliver(**IDENTITY)
        self.assertEqual(self.api.sends, 1)

    def test_lost_receipt_write_after_send_requires_reconciliation(self):
        sender = self.sender()
        write = sender._write
        def interrupted(directory, name, value):
            if name.endswith(".receipt.json"):
                raise delivery.DeliveryError("delivery_state_unavailable")
            return write(directory, name, value)
        sender._write = interrupted
        with self.assertRaises(delivery.DeliveryError):
            sender.deliver(**IDENTITY)
        self.assertEqual(self.api.sends, 1)
        with self.assertRaisesRegex(delivery.DeliveryUnknown, "reconciliation_required"):
            self.sender().deliver(**IDENTITY)
        self.assertEqual(self.api.sends, 1)

    def test_durable_ack_survives_interruption_before_confirmed_journal(self):
        sender = self.sender()
        write = sender._write
        def interrupted(directory, name, value):
            if name.endswith(".journal.json") and value.get("phase") == "confirmed":
                raise delivery.DeliveryError("delivery_state_unavailable")
            return write(directory, name, value)
        sender._write = interrupted
        with self.assertRaises(delivery.DeliveryError):
            sender.deliver(**IDENTITY)
        proof = self.sender().deliver(**IDENTITY)
        self.assertEqual(proof["evidence_scope"], "telegram-api-ack")
        self.assertEqual(self.api.sends, 1)

    def test_nonprivate_state_symlinks_and_corrupt_receipts_are_refused(self):
        self.state.mkdir(mode=0o755)
        with self.assertRaisesRegex(delivery.DeliveryError, "delivery_state_unsafe"):
            self.sender().deliver(**IDENTITY)
        self.state.rmdir()
        target = Path(self.scratch.name) / "other"
        target.mkdir(mode=0o700)
        self.state.symlink_to(target)
        with self.assertRaisesRegex(delivery.DeliveryError, "delivery_state_unsafe"):
            self.sender().deliver(**IDENTITY)
        self.state.unlink()
        self.sender().deliver(**IDENTITY)
        receipt = next(self.state.glob("*.receipt.json"))
        receipt.unlink()
        receipt.symlink_to(target / "secret")
        with self.assertRaisesRegex(delivery.DeliveryError, "delivery_state_unsafe"):
            self.sender().deliver(**IDENTITY)
        receipt.unlink()
        receipt.write_text("{}")
        receipt.chmod(0o600)
        with self.assertRaisesRegex(delivery.DeliveryError, "delivery_receipt_invalid"):
            self.sender().deliver(**IDENTITY)
        self.assertEqual(self.api.sends, 1)

    def test_plaintext_is_bounded_and_invalid_surrogates_are_rejected(self):
        for body in ("", " " * 5, "x" * 4001, "😀" * 2001, "bad\x00text", "\ud800"):
            with self.assertRaises(delivery.DeliveryError):
                self.sender().deliver(**{**IDENTITY, "body": body})
        self.assertEqual(self.api.calls, [])

    def test_production_client_has_fixed_https_origin_and_refuses_redirect(self):
        client = delivery._HttpsClient(TOKEN)
        requests = []
        class Response:
            code = 200
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, count): return b'{"ok":true}'
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response()
        client._opener = Opener()
        client("getMe", {})
        self.assertEqual(requests[0].full_url, "https://api.telegram.org/bot" + TOKEN + "/getMe")
        self.assertEqual(requests[0].get_method(), "POST")
        self.assertIsNone(delivery._NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.invalid"))
        with self.assertRaises(delivery.DeliveryError):
            client("unexpected", {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
