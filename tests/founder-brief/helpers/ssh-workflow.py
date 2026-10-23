"""Disposable SSH target wrapper. Internal test seams never enter production CLI."""
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time

HOME = Path(os.environ["HOME"])
sys.path.insert(0, str(HOME / "runtime.pyz"))
import deployment
import github_brief
import workflow

HERMES_HOME = HOME / ".hermes"
HERMES = str(HOME / "hermes-fixture")
DEPLOYMENT = deployment.Deployment(HERMES_HOME, HERMES, offline=True)


def telegram_client(port):
    def request(method, payload):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("POST", "/fixture/" + method, json.dumps(payload), {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, dict(response.headers), response.read()
        finally:
            connection.close()
    return request


def worker():
    port = int(os.environ["HSTACK_SSH_TEST_HTTP_PORT"])
    if not 1 <= port <= 65535:
        raise RuntimeError("invalid_test_port")
    result = workflow.execute(HERMES_HOME, _deployment=DEPLOYMENT,
                              _github_client=github_brief.GitHubClient._for_test("http://127.0.0.1:" + str(port)),
                              _telegram_client=telegram_client(port))
    print(json.dumps(result))


def canary():
    seen = {"github_gets": 0, "telegram_posts": 0, "sends": 0}

    class Api(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def answer(self, value):
            raw = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            seen["github_gets"] += 1
            if self.path.split("?")[0] == "/repos/acme/widget/commits":
                self.answer([{"sha": "a" * 40, "commit": {
                    "committer": {"date": (datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")},
                    "message": "Release tested reliability fix"}}])
            elif self.path.split("?")[0] in {"/repos/acme/widget/issues", "/repos/acme/widget/pulls"}:
                self.answer([])
            else:
                self.send_error(404)

        def do_POST(self):
            seen["telegram_posts"] += 1
            method = self.path.rsplit("/", 1)[-1]
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if method == "getMe":
                result = {"id": 123456, "is_bot": True}
            elif method == "getChat":
                result = {"id": 555000111, "type": "private"}
            elif method == "sendMessage":
                seen["sends"] += 1
                result = {"message_id": seen["sends"], "date": int(time.time()),
                          "from": {"id": 123456, "is_bot": True}, "chat": {"id": 555000111, "type": "private"},
                          "text": payload["text"]}
            else:
                self.send_error(404)
                return
            self.answer({"ok": True, "result": result})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Api)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    previous = os.environ.get("HSTACK_SSH_TEST_HTTP_PORT")
    os.environ["HSTACK_SSH_TEST_HTTP_PORT"] = str(server.server_port)
    try:
        receipt = DEPLOYMENT.verify_installation(verify_job=True)
        proof = workflow.run_canary(HERMES_HOME, receipt["review_hash"], "c" * 32, _deployment=DEPLOYMENT)
        replay = workflow.run_canary(HERMES_HOME, receipt["review_hash"], "c" * 32, _deployment=DEPLOYMENT)
        if proof != replay or seen["sends"] != 1:
            raise RuntimeError("replay_did_not_reconcile")
        print(json.dumps({"status": "loopback_api_ack", "native_command": proof["native_command"],
                          "delivery_scope": proof["delivery"]["evidence_scope"], "counts": seen}))
    finally:
        if previous is None:
            os.environ.pop("HSTACK_SSH_TEST_HTTP_PORT", None)
        else:
            os.environ["HSTACK_SSH_TEST_HTTP_PORT"] = previous
        server.shutdown()
        server.server_close()
        thread.join()


if sys.argv[1] == "install":
    value = json.load(sys.stdin)
    print(json.dumps(DEPLOYMENT.install((HOME / "runtime.pyz").read_bytes(), workflow.LAUNCHER,
                                       value["config"], value["credentials"])))
elif sys.argv[1] == "status":
    receipt = DEPLOYMENT.verify_installation(verify_job=True)
    calls = [json.loads(line) for line in (HERMES_HOME / "fixture-argv.jsonl").read_text().splitlines()]
    print(json.dumps({"phase": receipt["phase"], "job_id": receipt["job_id"],
                      "run_calls": [args for args in calls if args[2:4] == ["cron", "run"]]}))
elif sys.argv[1] == "worker":
    worker()
elif sys.argv[1] == "canary":
    canary()
elif sys.argv[1] == "rollback":
    print(json.dumps(DEPLOYMENT.rollback()))
else:
    raise SystemExit("unknown_test_operation")
