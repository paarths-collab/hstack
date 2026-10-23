"""Bounded Telegram API acknowledgements, never proof that a person read a brief.

The production endpoint is fixed. Native Hermes continues to own scheduling;
this sender owns a private per-window journal so an uncertain send is never
silently retried. Tests may inject the internal request callable, not an origin.
"""
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import time
import urllib.error
import urllib.request


MAX_BYTES = 1024 * 1024
MAX_TEXT_UNITS = 4000
MAX_RETRIES = 2
MAX_RETRY_AFTER = 3


class DeliveryError(Exception):
    """Only a fixed, credential-free code is exposed to callers."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class DeliveryUnknown(DeliveryError):
    """A send may have happened. Reconcile it; do not blindly retry."""


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result


def _decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("invalid")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid")))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _HttpsClient:
    def __init__(self, token):
        self._token = token
        # Ignore ambient proxy settings: neither a configurable origin nor a
        # redirect may receive the bot token. TLS verification remains enabled.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __call__(self, method, payload):
        if method not in {"getMe", "getChat", "sendMessage"}:
            raise DeliveryError("telegram_method_invalid")
        request = urllib.request.Request(
            "https://api.telegram.org/bot" + self._token + "/" + method,
            data=_json(payload), headers={"Content-Type": "application/json"}, method="POST")
        try:
            response = self._opener.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.code, dict(response.headers), response.read(MAX_BYTES + 1)


class TelegramDelivery:
    """deliver(...) returns a private, run-bound ``telegram-api-ack`` proof.

    run_id is stable for one logical window. Changing its body or run identity
    after a journal exists refuses rather than sending the window twice.
    ``_client``/``_sleep``/``_now`` are internal test seams, never configuration.
    """
    def __init__(self, state_dir, bot_token, github_token="", *, _client=None,
                 _sleep=time.sleep, _now=time.time):
        if not isinstance(bot_token, str) or not re.fullmatch(r"[1-9][0-9]{3,19}:[A-Za-z0-9_-]{20,}", bot_token):
            raise DeliveryError("telegram_token_invalid")
        if not isinstance(github_token, str):
            raise DeliveryError("github_token_invalid")
        self._bot_id = int(bot_token.split(":", 1)[0])
        self._secrets = [value for value in (bot_token, github_token) if value]
        self._client = _client if _client is not None else _HttpsClient(bot_token)
        self._sleep, self._now = _sleep, _now
        self._state_dir = os.fspath(state_dir)
        if not isinstance(self._state_dir, str) or not os.path.isabs(self._state_dir) or "\x00" in self._state_dir:
            raise DeliveryError("delivery_state_unsafe")

    @staticmethod
    def _private_file(fd):
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise DeliveryError("delivery_state_unsafe")
        return info

    def _open_state(self):
        if not os.path.isabs(self._state_dir):
            raise DeliveryError("delivery_state_unsafe")
        try:
            os.mkdir(self._state_dir, 0o700)
        except FileExistsError:
            pass
        except OSError:
            raise DeliveryError("delivery_state_unavailable") from None
        try:
            fd = os.open(self._state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                os.close(fd)
                raise DeliveryError("delivery_state_unsafe")
            return fd
        except OSError:
            raise DeliveryError("delivery_state_unsafe") from None

    def _read(self, directory, name):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        except OSError:
            raise DeliveryError("delivery_state_unsafe") from None
        try:
            if self._private_file(fd).st_size > MAX_BYTES:
                raise DeliveryError("delivery_state_invalid")
            with os.fdopen(fd, "rb") as source:
                fd = None
                return _decode(source.read(MAX_BYTES + 1))
        except (ValueError, UnicodeError, RecursionError):
            raise DeliveryError("delivery_state_invalid") from None
        finally:
            if fd is not None:
                os.close(fd)

    def _write(self, directory, name, value):
        # Refuse unsafe pre-existing paths even though rename itself never
        # follows a symlink. Directory descriptors keep all files in one state.
        self._read(directory, name)
        temporary = ".pending-" + secrets.token_hex(16)
        fd = None
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "wb") as out:
                fd = None
                out.write(_json(value) + b"\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        except OSError:
            raise DeliveryError("delivery_state_unavailable") from None
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass

    def _request(self, method, payload, sending=False):
        try:
            status, headers, raw = self._client(method, payload)
            if type(status) is not int or not 100 <= status <= 599:
                raise ValueError("invalid")
            value = _decode(raw)
            if not isinstance(value, dict):
                raise ValueError("invalid")
            return status, value
        except Exception:
            error = DeliveryUnknown if sending else DeliveryError
            raise error("telegram_response_unknown" if sending else "telegram_validation_failed") from None

    def _validate_peer(self, chat_id):
        status, value = self._request("getMe", {})
        bot = value.get("result")
        if status != 200 or value.get("ok") is not True or not isinstance(bot, dict) or type(bot.get("id")) is not int or bot["id"] != self._bot_id or bot.get("is_bot") is not True:
            raise DeliveryError("telegram_bot_mismatch")
        status, value = self._request("getChat", {"chat_id": chat_id})
        chat = value.get("result")
        if status != 200 or value.get("ok") is not True or not isinstance(chat, dict) or type(chat.get("id")) is not int or chat["id"] != chat_id or chat.get("type") != "private":
            raise DeliveryError("telegram_private_chat_mismatch")

    def _lock(self, directory, logical):
        descriptor = None
        try:
            try:
                descriptor = os.open(logical + ".lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
            except FileExistsError:
                descriptor = os.open(logical + ".lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            self._private_file(descriptor)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            return descriptor
        except OSError:
            if descriptor is not None:
                os.close(descriptor)
            raise DeliveryError("delivery_state_unsafe") from None
        except DeliveryError:
            if descriptor is not None:
                os.close(descriptor)
            raise

    @staticmethod
    def _journal_valid(journal):
        return (isinstance(journal, dict) and set(journal) == {"schema_version", "identity", "phase", "attempts"}
                and journal.get("schema_version") == 1 and type(journal.get("attempts")) is int
                and 0 <= journal["attempts"] <= MAX_RETRIES + 1)

    def lookup(self, *, config_hash, window_id, chat_id):
        """Before fetching GitHub, reuse a confirmed window or stop uncertainty.

        Returns None only when this window has no send or only a prepared
        pre-send journal. This performs no Telegram requests.
        """
        if (not isinstance(config_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", config_hash)
                or not isinstance(window_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:+-]{1,128}", window_id)):
            raise DeliveryError("delivery_identity_invalid")
        if any(secret in value for secret in self._secrets for value in (config_hash, window_id)):
            raise DeliveryError("delivery_identity_invalid")
        if isinstance(chat_id, str) and re.fullmatch(r"[1-9][0-9]{0,19}", chat_id):
            chat_id = int(chat_id)
        if type(chat_id) is not int or not 0 < chat_id <= 2**63 - 1:
            raise DeliveryError("telegram_private_chat_invalid")
        destination = _digest("telegram:" + str(chat_id))[:16]
        logical = _digest(config_hash + "\n" + window_id + "\n" + destination)
        if not os.path.lexists(self._state_dir):
            return None
        directory = self._open_state()
        lock = None
        try:
            lock = self._lock(directory, logical)
            journal = self._read(directory, logical + ".journal.json")
            receipt = self._read(directory, logical + ".receipt.json")
            if journal is None:
                if receipt is not None:
                    raise DeliveryError("delivery_receipt_without_journal")
                return None
            if not self._journal_valid(journal):
                raise DeliveryError("delivery_state_invalid")
            identity = journal.get("identity")
            expected = {"config_hash": config_hash, "window_id": window_id, "destination_fp": destination,
                        "bot_fp": _digest("telegram-bot:" + str(self._bot_id))[:16]}
            if (not isinstance(identity, dict) or set(identity) != set(expected) | {"run_id", "body_sha256"}
                    or any(identity.get(key) != value for key, value in expected.items())
                    or not isinstance(identity.get("body_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", identity["body_sha256"])
                    or not isinstance(identity.get("run_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", identity["run_id"])):
                raise DeliveryError("delivery_identity_conflict")
            if receipt is not None:
                if not self._valid_receipt(receipt, identity):
                    raise DeliveryError("delivery_receipt_invalid")
                return receipt
            if journal.get("phase") in {"sending", "unknown", "confirmed"}:
                raise DeliveryUnknown("telegram_delivery_unknown_reconciliation_required")
            if journal.get("phase") == "rejected":
                raise DeliveryError("telegram_delivery_rejected")
            if journal.get("phase") != "prepared":
                raise DeliveryError("delivery_state_invalid")
            return None
        except OSError:
            raise DeliveryError("delivery_state_unavailable") from None
        finally:
            if lock is not None:
                os.close(lock)
            os.close(directory)

    def deliver(self, *, run_id, config_hash, window_id, body, chat_id):
        if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", run_id):
            raise DeliveryError("delivery_identity_invalid")
        if not isinstance(config_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", config_hash):
            raise DeliveryError("delivery_identity_invalid")
        if not isinstance(window_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:+-]{1,128}", window_id):
            raise DeliveryError("delivery_identity_invalid")
        if any(secret in value for secret in self._secrets for value in (run_id, config_hash, window_id)):
            raise DeliveryError("delivery_identity_invalid")
        if isinstance(chat_id, str) and re.fullmatch(r"[1-9][0-9]{0,19}", chat_id):
            chat_id = int(chat_id)
        if type(chat_id) is not int or not 0 < chat_id <= 2**63 - 1:
            raise DeliveryError("telegram_private_chat_invalid")
        if not isinstance(body, str) or not body.strip() or "\x00" in body:
            raise DeliveryError("telegram_body_invalid")
        try:
            units = len(body.encode("utf-16-le")) // 2
        except UnicodeError:
            raise DeliveryError("telegram_body_invalid") from None
        if units > MAX_TEXT_UNITS:
            raise DeliveryError("telegram_body_too_long")
        if any(secret in body for secret in self._secrets):
            raise DeliveryError("telegram_body_contains_credential")
        identity = {"run_id": run_id, "config_hash": config_hash, "window_id": window_id,
                    "body_sha256": _digest(body), "destination_fp": _digest("telegram:" + str(chat_id))[:16],
                    "bot_fp": _digest("telegram-bot:" + str(self._bot_id))[:16]}
        logical = _digest(config_hash + "\n" + window_id + "\n" + identity["destination_fp"])
        directory = self._open_state()
        lock = None
        journal_name, receipt_name = logical + ".journal.json", logical + ".receipt.json"
        try:
            lock = self._lock(directory, logical)
            journal = self._read(directory, journal_name)
            receipt = self._read(directory, receipt_name)
            if journal is not None:
                if not self._journal_valid(journal):
                    raise DeliveryError("delivery_state_invalid")
                if journal.get("identity") != identity:
                    raise DeliveryError("delivery_identity_conflict")
                if receipt is not None:
                    if not self._valid_receipt(receipt, identity):
                        raise DeliveryError("delivery_receipt_invalid")
                    return receipt
                if journal.get("phase") in {"sending", "unknown"}:
                    raise DeliveryUnknown("telegram_delivery_unknown_reconciliation_required")
                if journal.get("phase") == "rejected":
                    raise DeliveryError("telegram_delivery_rejected")
                # An interrupted pre-send journal is safe to resume because no
                # send was attempted until phase=sending was durably recorded.
                if journal.get("phase") != "prepared":
                    raise DeliveryError("delivery_state_invalid")
            elif receipt is not None:
                raise DeliveryError("delivery_receipt_without_journal")
            self._validate_peer(chat_id)
            journal = {"schema_version": 1, "identity": identity, "phase": "prepared", "attempts": 0}
            self._write(directory, journal_name, journal)
            for attempt in range(MAX_RETRIES + 1):
                journal.update(phase="sending", attempts=attempt + 1)
                self._write(directory, journal_name, journal)
                started = int(self._now())
                try:
                    status, value = self._request("sendMessage", {
                        "chat_id": chat_id, "text": body, "disable_web_page_preview": True,
                    }, sending=True)
                    if status == 429 and value.get("ok") is False and value.get("error_code") == 429:
                        retry = value.get("parameters", {}).get("retry_after") if isinstance(value.get("parameters"), dict) else None
                        journal.update(phase="rejected")
                        self._write(directory, journal_name, journal)
                        if type(retry) is not int or not 0 <= retry <= MAX_RETRY_AFTER or attempt == MAX_RETRIES:
                            raise DeliveryError("telegram_rate_limited")
                        self._sleep(retry)
                        continue
                    if 400 <= status < 500 and status != 429 and value.get("ok") is False:
                        journal.update(phase="rejected")
                        self._write(directory, journal_name, journal)
                        raise DeliveryError("telegram_delivery_rejected")
                    if status != 200 or value.get("ok") is not True:
                        raise DeliveryUnknown("telegram_response_unknown")
                    message = value.get("result")
                    if not self._valid_message(message, chat_id, body, started):
                        raise DeliveryUnknown("telegram_ack_mismatch")
                    receipt = {"schema_version": 1, "status": "confirmed", "evidence_scope": "telegram-api-ack",
                               "recipient_read": False, **identity,
                               "message_id": message["message_id"], "telegram_date": message["date"],
                               "acknowledged_at": int(self._now())}
                    self._write(directory, receipt_name, receipt)
                    journal.update(phase="confirmed")
                    self._write(directory, journal_name, journal)
                    return receipt
                except DeliveryUnknown:
                    journal.update(phase="unknown")
                    self._write(directory, journal_name, journal)
                    raise
                except DeliveryError:
                    # A receipt-write failure after a successful send remains
                    # sending/unknown on disk, and cannot cause an automatic retry.
                    if journal.get("phase") == "rejected":
                        raise
                    raise DeliveryUnknown("telegram_delivery_unknown_reconciliation_required") from None
                except Exception:
                    journal.update(phase="unknown")
                    try:
                        self._write(directory, journal_name, journal)
                    except DeliveryError:
                        pass
                    raise DeliveryUnknown("telegram_delivery_unknown_reconciliation_required") from None
        except OSError:
            raise DeliveryError("delivery_state_unavailable") from None
        finally:
            if lock is not None:
                os.close(lock)
            os.close(directory)

    def _valid_message(self, message, chat_id, body, started):
        if not isinstance(message, dict):
            return False
        chat, sender = message.get("chat"), message.get("from")
        return (type(message.get("message_id")) is int and message["message_id"] > 0
                and type(message.get("date")) is int and started - 30 <= message["date"] <= int(self._now()) + 30
                and message.get("text") == body and isinstance(chat, dict)
                and type(chat.get("id")) is int and chat["id"] == chat_id and chat.get("type") == "private"
                and isinstance(sender, dict) and type(sender.get("id")) is int
                and sender["id"] == self._bot_id and sender.get("is_bot") is True)

    @staticmethod
    def _valid_receipt(receipt, identity):
        fields = set(identity) | {"schema_version", "status", "evidence_scope", "recipient_read", "message_id", "telegram_date", "acknowledged_at"}
        return (isinstance(receipt, dict) and set(receipt) == fields and all(receipt.get(key) == value for key, value in identity.items())
                and receipt.get("schema_version") == 1 and receipt.get("status") == "confirmed" and receipt.get("evidence_scope") == "telegram-api-ack"
                and receipt.get("recipient_read") is False and type(receipt.get("message_id")) is int
                and receipt["message_id"] > 0 and type(receipt.get("telegram_date")) is int
                and receipt["telegram_date"] > 0 and type(receipt.get("acknowledged_at")) is int
                and receipt["acknowledged_at"] >= receipt["telegram_date"] - 30)
