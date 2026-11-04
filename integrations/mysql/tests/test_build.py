"""Offline tests of bounded source changes; no compiler/download/database needed."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("mysql_builder", Path(__file__).parents[1] / "build-toolbox.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


class BuildTests(unittest.TestCase):
    def test_registration_patch_keeps_all_mysql_types_and_license(self):
        entries = ["sources/mysql"] + ["tools/mysql/" + name for name in [
            "mysqlexecutesql", "mysqlgetqueryplan", "mysqllistactivequeries", "mysqllistalllocks",
            "mysqllisttablefragmentation", "mysqllisttables", "mysqllisttablesmissinguniqueindexes",
            "mysqllisttablestats", "mysqlshowquerystats", "mysqlsql"]]
        imports = entries + ["sources/snowflake", "tools/snowflake/unused"]
        source = ("// synthetic licence\npackage internal\nimport (\n" + "\n".join(
            f'\t_ "github.com/googleapis/mcp-toolbox/internal/{name}"' for name in imports) + "\n)\n").encode()
        patched = builder.mysql_registrations(source, blob(source))
        self.assertTrue(patched.startswith(b"// synthetic licence\n"))
        self.assertNotIn(b"snowflake", patched)
        for entry in entries:
            self.assertIn(entry.encode(), patched)
        self.assertEqual(patched.count(b'\t_ "'), 11)

    def test_changed_source_or_missing_native_tools_are_rejected(self):
        source = b'package internal\nimport (\n_ "github.com/googleapis/mcp-toolbox/internal/sources/mysql"\n)\n'
        with self.assertRaises(ValueError):
            builder.mysql_registrations(source, "wrong")
        with self.assertRaises(ValueError):
            builder.mysql_registrations(source, blob(source))

    def test_telemetry_patch_changes_only_the_reviewed_schema_import(self):
        source = b'// synthetic licence\nimport semconv "go.opentelemetry.io/otel/semconv/v1.41.0"\n'
        self.assertEqual(builder.align_telemetry(source, blob(source)), source.replace(b"v1.41.0", b"v1.43.0"))
        with self.assertRaises(ValueError):
            builder.align_telemetry(source, "wrong")
        other = source.replace(b"v1.41.0", b"v1.42.0")
        with self.assertRaises(ValueError):
            builder.align_telemetry(other, blob(other))


if __name__ == "__main__":
    unittest.main()
